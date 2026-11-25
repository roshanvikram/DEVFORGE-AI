import { db, now, json } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { publishToUser, publish } from "../lib/events.js";
import { log } from "../lib/logger.js";
import { registerHandler } from "../jobs/queue.js";
import { providerFor } from "../ai/provider.js";
import { getSettings } from "./integrations.js";
import { searchCode, searchSymbols, queryTerms } from "./search.js";

/**
 * Retrieval-augmented generation over a repository.
 *
 *  Index:     every code file of the current snapshot is split into ~40-line chunks (snapped to symbol
 *             starts where possible) and embedded locally with a hashed TF-IDF model over identifier
 *             sub-tokens and character trigrams. Code never leaves the server to be indexed.
 *  Retrieve:  four rankers — vector cosine, BM25 (FTS5), symbol-name match, import-graph expansion —
 *             fused with Reciprocal Rank Fusion; knowledge-base documents join through BM25.
 *  Generate:  the configured AI provider answers from numbered sources only; tokens stream to the asking
 *             user over the WebSocket hub, and citations are checked against the retrieved line ranges.
 */

export const DIMS = 512;
const CHUNK_LINES = 40;
const OVERLAP = 8;
const SKIP_LANGS = new Set(["json", "yaml", "markdown", "text", "toml", "xml", "dotenv", "lock"]);

/* ───────────── Local embedding (hashed TF-IDF) ───────────── */

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Identifier-aware tokens: whole identifiers, camel/snake sub-tokens, and character trigrams of sub-tokens. */
export function embedTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z_][A-Za-z0-9_]{1,40}/g) ?? []) {
    const whole = raw.toLowerCase();
    out.push("w:" + whole);
    const subs = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    for (const s of subs) {
      if (s !== whole) out.push("w:" + s);
      if (s.length >= 4) for (let i = 0; i + 3 <= s.length; i++) out.push("g:" + s.slice(i, i + 3));
    }
  }
  return out;
}

function termFreq(text: string): Map<number, number> {
  const tf = new Map<number, number>();
  for (const t of embedTokens(text)) {
    const b = fnv1a(t) % DIMS;
    tf.set(b, (tf.get(b) ?? 0) + (t.startsWith("g:") ? 0.35 : 1));
  }
  return tf;
}

export function embed(text: string, idf: Float32Array): Float32Array {
  const v = new Float32Array(DIMS);
  for (const [b, c] of termFreq(text)) v[b] = (1 + Math.log(c)) * idf[b];
  let n = 0;
  for (let i = 0; i < DIMS; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIMS; i++) v[i] /= n;
  return v;
}

const dot = (a: Float32Array, b: Float32Array, off = 0) => {
  let s = 0;
  for (let i = 0; i < DIMS; i++) s += a[i] * b[off + i];
  return s;
};

/* ───────────── Indexing ───────────── */

type Chunk = { path: string; start: number; end: number; symbol: string | null; text: string };

function chunkFile(path: string, content: string, symbolStarts: { line: number; name: string }[]): Chunk[] {
  const lines = content.split("\n");
  if (!lines.length || (lines.length === 1 && !lines[0].trim())) return [];
  const chunks: Chunk[] = [];
  const starts = symbolStarts.filter((s) => s.line > 0).sort((a, b) => a.line - b.line);
  let s = 1;
  while (s <= lines.length) {
    let e = Math.min(lines.length, s + CHUNK_LINES - 1);
    // Prefer ending just before the next symbol that starts inside the back half of the window.
    const next = starts.find((x) => x.line > s + CHUNK_LINES / 2 && x.line <= e);
    if (next && e < lines.length) e = next.line - 1;
    const sym = [...starts].reverse().find((x) => x.line <= e && x.line >= s) ?? [...starts].reverse().find((x) => x.line < s);
    const text = lines.slice(s - 1, e).join("\n");
    if (text.trim()) chunks.push({ path, start: s, end: e, symbol: sym?.name ?? null, text });
    if (e >= lines.length) break;
    s = Math.max(s + 1, e + 1 - OVERLAP);
  }
  return chunks;
}

const cache = new Map<string, { ids: number[]; meta: { path: string; start: number; end: number; symbol: string | null }[]; vecs: Float32Array; idf: Float32Array }>();

/** Builds (or rebuilds) the RAG index for a repository's current snapshot. */
export function buildIndex(repositoryId: string, onProgress?: (p: number, m: string) => void) {
  const started = Date.now();
  const d = db();
  const repo = d.prepare(`SELECT id, workspace_id, current_snapshot_id FROM repositories WHERE id = ?`).get(repositoryId) as any;
  if (!repo?.current_snapshot_id) throw new Error("Repository has not been indexed yet");
  const snap = repo.current_snapshot_id as string;
  const files = d.prepare(`SELECT c.path, c.content, f.id AS file_id, f.language FROM code_fts c JOIN files f ON f.id = c.file_id WHERE c.snapshot_id = ?`).all(snap) as any[];
  const symStmt = d.prepare(`SELECT name, line FROM symbols WHERE file_id = ?`);
  const chunks: Chunk[] = [];
  for (const f of files) {
    if (f.language && SKIP_LANGS.has(f.language)) continue;
    chunks.push(...chunkFile(f.path, f.content ?? "", symStmt.all(f.file_id) as any[]));
  }
  onProgress?.(0.3, `Chunked ${files.length} files into ${chunks.length} chunks`);
  // Document frequency per hashed bucket → smoothed IDF.
  const df = new Float32Array(DIMS);
  const tfs = chunks.map((c) => {
    const tf = termFreq(c.path + "\n" + c.text);
    for (const b of tf.keys()) df[b]++;
    return tf;
  });
  const idf = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) idf[i] = Math.log(1 + (chunks.length + 1) / (df[i] + 1));
  onProgress?.(0.6, "Embedding chunks");
  const ins = d.prepare(`INSERT INTO rag_chunks (snapshot_id, path, start_line, end_line, symbol, text, vec) VALUES (?,?,?,?,?,?,?)`);
  d.transaction(() => {
    d.prepare(`DELETE FROM rag_chunks WHERE snapshot_id = ?`).run(snap);
    chunks.forEach((c, i) => {
      const v = new Float32Array(DIMS);
      for (const [b, n] of tfs[i]) v[b] = (1 + Math.log(n)) * idf[b];
      let norm = 0;
      for (let k = 0; k < DIMS; k++) norm += v[k] * v[k];
      norm = Math.sqrt(norm) || 1;
      for (let k = 0; k < DIMS; k++) v[k] /= norm;
      ins.run(snap, c.path, c.start, c.end, c.symbol, c.text, Buffer.from(v.buffer));
    });
    d.prepare(`INSERT INTO rag_index (snapshot_id, repository_id, chunks, files, dims, idf, build_ms, built_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_id) DO UPDATE SET chunks=excluded.chunks, files=excluded.files, dims=excluded.dims, idf=excluded.idf, build_ms=excluded.build_ms, built_at=excluded.built_at`)
      .run(snap, repositoryId, chunks.length, new Set(chunks.map((c) => c.path)).size, DIMS, Buffer.from(idf.buffer), Date.now() - started, now());
  })();
  cache.delete(snap);
  publish(repo.workspace_id, { type: "rag.index", repositoryId, chunks: chunks.length });
  onProgress?.(1, "Index ready");
  return { chunks: chunks.length, files: new Set(chunks.map((c) => c.path)).size, ms: Date.now() - started };
}

registerHandler("rag.index", async (ctx) => buildIndex(ctx.payload.repositoryId, (p, m) => ctx.progress(p, m)));

export function indexStatus(repositoryId: string) {
  const repo = db().prepare(`SELECT current_snapshot_id FROM repositories WHERE id = ?`).get(repositoryId) as any;
  if (!repo?.current_snapshot_id) return { ready: false, reason: "not_indexed" as const };
  const r = db().prepare(`SELECT chunks, files, dims, build_ms, built_at FROM rag_index WHERE snapshot_id = ?`).get(repo.current_snapshot_id) as any;
  return r ? { ready: true, ...r, embedding: "local hashed TF-IDF (identifier sub-tokens + trigrams)" } : { ready: false, reason: "not_built" as const };
}

function loadIndex(snap: string) {
  const hit = cache.get(snap);
  if (hit) return hit;
  const meta = db().prepare(`SELECT idf FROM rag_index WHERE snapshot_id = ?`).get(snap) as any;
  if (!meta) return null;
  const rows = db().prepare(`SELECT id, path, start_line, end_line, symbol, vec FROM rag_chunks WHERE snapshot_id = ? ORDER BY id`).all(snap) as any[];
  const vecs = new Float32Array(rows.length * DIMS);
  rows.forEach((r, i) => vecs.set(new Float32Array(r.vec.buffer, r.vec.byteOffset, DIMS), i * DIMS));
  const idfBuf = meta.idf as Buffer;
  const entry = { ids: rows.map((r) => r.id), meta: rows.map((r) => ({ path: r.path, start: r.start_line, end: r.end_line, symbol: r.symbol })), vecs, idf: new Float32Array(idfBuf.buffer.slice(idfBuf.byteOffset, idfBuf.byteOffset + DIMS * 4)) };
  if (cache.size > 8) cache.clear();
  cache.set(snap, entry);
  return entry;
}

/* ───────────── Hybrid retrieval ───────────── */

export type Source = {
  n: number; kind: "code" | "doc"; path: string; title?: string; startLine: number; endLine: number; symbol: string | null; text: string;
  score: number; signals: { vector?: number; bm25?: number; symbol?: number; graph?: number; kb?: number };
};

const RRF_K = 60;

export function retrieve(repositoryId: string, workspaceId: string, question: string, k = 8): { sources: Source[]; ms: number } {
  const t0 = Date.now();
  const d = db();
  const repo = d.prepare(`SELECT current_snapshot_id FROM repositories WHERE id = ?`).get(repositoryId) as any;
  const snap = repo.current_snapshot_id as string;
  let idx = loadIndex(snap);
  if (!idx) {
    buildIndex(repositoryId);
    idx = loadIndex(snap)!;
  }
  const fused = new Map<number, { score: number; signals: Source["signals"] }>();
  const add = (i: number, rank: number, sig: keyof Source["signals"], weight = 1) => {
    const e = fused.get(i) ?? { score: 0, signals: {} };
    e.score += weight / (RRF_K + rank);
    e.signals[sig] = rank + 1;
    fused.set(i, e);
  };
  // 1. Vector similarity.
  const q = embed(question, idx.idf);
  const sims: { i: number; s: number }[] = [];
  for (let i = 0; i < idx.ids.length; i++) sims.push({ i, s: dot(q, idx.vecs, i * DIMS) });
  sims.sort((a, b) => b.s - a.s);
  sims.slice(0, 30).forEach((x, r) => x.s > 0 && add(x.i, r, "vector"));
  const chunkAt = (path: string, line: number) => idx!.meta.findIndex((m) => m.path === path && m.start <= line && m.end >= line);
  // 2. BM25 over file content → the chunk holding the first match.
  searchCode(snap, question, { limit: 20 }).forEach((h, r) => {
    const i = chunkAt(h.path, h.matches[0]?.line ?? 1);
    if (i >= 0) add(i, r, "bm25");
  });
  // 3. Symbol-name matches.
  const terms = queryTerms(question).sort((a, b) => b.length - a.length).slice(0, 3);
  let sr = 0;
  for (const t of terms) for (const s of searchSymbols(snap, t, 6) as any[]) {
    const i = chunkAt(s.path, s.line);
    if (i >= 0) add(i, sr++, "symbol", 1.2);
  }
  // 4. Graph expansion: files imported by the top results contribute their best-matching chunk.
  const top = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 3);
  const topPaths = [...new Set(top.map(([i]) => idx!.meta[i].path))];
  if (topPaths.length) {
    const neighbours = d.prepare(`SELECT DISTINCT tf.path FROM edges e JOIN files sf ON sf.id = e.source_file_id JOIN files tf ON tf.id = e.target_file_id WHERE e.snapshot_id = ? AND e.kind = 'import' AND sf.path IN (${topPaths.map(() => "?").join(",")})`).all(snap, ...topPaths) as { path: string }[];
    let gr = 0;
    for (const nb of neighbours.slice(0, 6)) {
      const best = sims.find((x) => idx!.meta[x.i].path === nb.path);
      if (best && best.s > 0) add(best.i, gr++, "graph", 0.6);
    }
  }
  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, k);
  const textStmt = d.prepare(`SELECT text FROM rag_chunks WHERE id = ?`);
  const sources: Source[] = ranked.map(([i, e], n) => {
    const m = idx!.meta[i];
    return { n: n + 1, kind: "code", path: m.path, startLine: m.start, endLine: m.end, symbol: m.symbol, text: (textStmt.get(idx!.ids[i]) as any).text, score: Math.round(e.score * 10000) / 10000, signals: e.signals };
  });
  // Knowledge-base documents (BM25 over kb_fts).
  const fq = terms.length ? terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ") : null;
  if (fq) {
    try {
      const docs = d.prepare(`SELECT d.id, d.title, d.content FROM kb_fts JOIN knowledge_docs d ON d.id = kb_fts.doc_id WHERE kb_fts MATCH ? AND kb_fts.workspace_id = ? ORDER BY bm25(kb_fts) LIMIT 2`).all(fq, workspaceId) as any[];
      docs.forEach((doc, r) => sources.push({ n: sources.length + 1, kind: "doc", path: `kb/${doc.id}`, title: doc.title, startLine: 1, endLine: Math.min(60, doc.content.split("\n").length), symbol: null, text: doc.content.split("\n").slice(0, 60).join("\n"), score: Math.round((1 / (RRF_K + r)) * 10000) / 10000, signals: { kb: r + 1 } }));
    } catch { /* malformed FTS query: skip KB */ }
  }
  return { sources, ms: Date.now() - t0 };
}

/* ───────────── Generation with streaming + citation checks ───────────── */

export function checkCitations(answer: string, sources: Source[]) {
  const out: { ref: string; source: number | null; verified: boolean }[] = [];
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (!out.some((o) => o.ref === m[0])) out.push({ ref: m[0], source: n, verified: sources.some((s) => s.n === n) });
  }
  for (const m of answer.matchAll(/`?([\w./-]+\.[a-z]{1,5}):(\d{1,6})`?/gi)) {
    const [, p, l] = m;
    const line = Number(l);
    const src = sources.find((s) => s.kind === "code" && (s.path === p || s.path.endsWith("/" + p)) && line >= s.startLine && line <= s.endLine);
    const ref = `${p}:${l}`;
    if (!out.some((o) => o.ref === ref)) out.push({ ref, source: src?.n ?? null, verified: !!src });
  }
  return out;
}

const SYSTEM = `You are DevForge's codebase copilot. Answer ONLY from the numbered sources provided.
- Cite every claim with the source number in square brackets, e.g. [2], and name code locations as path:line.
- If the sources do not contain the answer, say so plainly and suggest where to look. Never invent files, functions or behaviour.
- Be concise and use Markdown.`;

export async function ask(params: { workspaceId: string; repositoryId: string; userId: string; question: string }): Promise<string> {
  const id = newId("rag_");
  db().prepare(`INSERT INTO rag_queries (id, workspace_id, repository_id, user_id, question) VALUES (?,?,?,?,?)`).run(id, params.workspaceId, params.repositoryId, params.userId, params.question);
  void run(id, params);
  return id;
}

async function run(id: string, p: { workspaceId: string; repositoryId: string; userId: string; question: string }) {
  const t0 = Date.now();
  const emit = (e: Record<string, unknown>) => publishToUser(p.userId, { type: "rag", id, ...e });
  const fail = (msg: string) => {
    db().prepare(`UPDATE rag_queries SET status = 'failed', error = ?, total_ms = ? WHERE id = ?`).run(msg, Date.now() - t0, id);
    emit({ phase: "error", error: msg });
  };
  try {
    emit({ phase: "retrieving" });
    const { sources, ms } = retrieve(p.repositoryId, p.workspaceId, p.question);
    db().prepare(`UPDATE rag_queries SET sources = ?, retrieval_ms = ? WHERE id = ?`).run(JSON.stringify(sources.map(({ text, ...s }) => ({ ...s, preview: text.slice(0, 400) }))), ms, id);
    emit({ phase: "sources", sources: sources.map(({ text, ...s }) => ({ ...s, preview: text.slice(0, 400) })), retrievalMs: ms });
    const ai = providerFor(p.workspaceId, p.userId);
    if (!ai || !getSettings(p.workspaceId).ai.allowCodeSnippetsToAI) {
      const note = !ai ? "No AI provider is configured — showing the retrieved evidence only." : "Sending code to the AI provider is disabled in workspace settings — showing the retrieved evidence only.";
      db().prepare(`UPDATE rag_queries SET status = 'retrieval_only', answer = NULL, error = ?, total_ms = ? WHERE id = ?`).run(note, Date.now() - t0, id);
      emit({ phase: "done", retrievalOnly: true, note });
      return;
    }
    emit({ phase: "generating", provider: ai.id, model: ai.model });
    let buf = "";
    let last = 0;
    const flush = () => {
      if (buf) emit({ phase: "token", text: buf });
      buf = "";
      last = Date.now();
    };
    const context = sources.map((s) => `[${s.n}] ${s.kind === "doc" ? `Knowledge base: ${s.title}` : `${s.path}:${s.startLine}-${s.endLine}${s.symbol ? ` (${s.symbol})` : ""}`}\n${s.text.split("\n").map((l, i) => (s.kind === "code" ? `${String(s.startLine + i).padStart(5)}| ${l}` : l)).join("\n")}`).join("\n\n");
    const resp = await ai.complete({
      feature: "rag_copilot",
      system: SYSTEM,
      maxTokens: 4000,
      messages: [{ role: "user", content: `Question: ${p.question}\n\nSources:\n${context}` }],
      onText: (t) => {
        buf += t;
        if (Date.now() - last > 60) flush();
      },
    });
    flush();
    const citations = checkCitations(resp.text, sources);
    db().prepare(`UPDATE rag_queries SET status = 'completed', answer = ?, citations = ?, provider = ?, model = ?, total_ms = ? WHERE id = ?`).run(resp.text, JSON.stringify(citations), ai.id, resp.model, Date.now() - t0, id);
    emit({ phase: "done", answer: resp.text, citations, provider: ai.id, model: resp.model, usage: resp.usage, totalMs: Date.now() - t0 });
  } catch (e: any) {
    log.warn("rag query failed", { id, error: String(e?.message ?? e) });
    fail(String(e?.message ?? e).slice(0, 500));
  }
}

export function getQuery(id: string, workspaceId: string) {
  const q = db().prepare(`SELECT * FROM rag_queries WHERE id = ? AND workspace_id = ?`).get(id, workspaceId) as any;
  return q ? { ...q, sources: json(q.sources, []), citations: json(q.citations, []) } : null;
}

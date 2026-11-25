import fs from "node:fs";
import path from "node:path";
import { db } from "../db/db.js";

const STOP = new Set(["the", "a", "an", "is", "are", "of", "to", "in", "and", "or", "for", "on", "how", "what", "where", "does", "do", "with", "this", "that", "it", "be", "by", "from", "which", "why", "when", "can", "i", "we", "you"]);

/** Splits camelCase/snake_case and removes stop words; returns safe FTS5 terms. */
export function queryTerms(q: string): string[] {
  const raw = q.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1 && !STOP.has(t));
  const orig = q.split(/[^A-Za-z0-9_]+/).filter((t) => t.length > 2).map((t) => t.toLowerCase());
  return [...new Set([...orig, ...raw])].slice(0, 12);
}

export function ftsQuery(q: string, mode: "and" | "or" = "or"): string | null {
  const terms = queryTerms(q);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(mode === "and" ? " AND " : " OR ");
}

export interface CodeHit { fileId: string; path: string; score: number; matches: { line: number; text: string }[] }

export function searchCode(snapshotId: string, q: string, opts: { limit?: number; exact?: boolean; pathFilter?: string } = {}): CodeHit[] {
  const limit = Math.min(opts.limit ?? 30, 100);
  let rows: any[] = [];
  if (opts.exact) {
    rows = db().prepare(`SELECT file_id, path, content, 0 AS score FROM code_fts WHERE snapshot_id = ? AND instr(content, ?) > 0 LIMIT ?`).all(snapshotId, q, limit) as any[];
  } else {
    const fq = ftsQuery(q);
    if (!fq) return [];
    try {
      rows = db().prepare(`SELECT file_id, path, content, bm25(code_fts, 4.0, 1.0) AS score FROM code_fts WHERE code_fts MATCH ? AND snapshot_id = ? ORDER BY score LIMIT ?`).all(fq, snapshotId, limit) as any[];
    } catch {
      rows = [];
    }
  }
  const terms = opts.exact ? [q.toLowerCase()] : queryTerms(q);
  return rows
    .filter((r) => !opts.pathFilter || r.path.includes(opts.pathFilter))
    .map((r) => {
      const lines: string[] = r.content.split("\n");
      const matches: { line: number; text: string }[] = [];
      for (let i = 0; i < lines.length && matches.length < 8; i++) {
        const l = lines[i].toLowerCase();
        if (terms.some((t) => l.includes(t))) matches.push({ line: i + 1, text: lines[i].slice(0, 240) });
      }
      return { fileId: r.file_id, path: r.path, score: -r.score, matches };
    });
}

export function searchSymbols(snapshotId: string, q: string, limit = 30) {
  const like = `%${q.replace(/[%_]/g, "")}%`;
  return db()
    .prepare(
      `SELECT s.id, s.name, s.kind, s.parent, s.line, s.end_line, s.signature, s.exported, s.complexity, f.path, f.id AS file_id
       FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.snapshot_id = ? AND s.name LIKE ? ORDER BY (s.name = ?) DESC, length(s.name) LIMIT ?`,
    )
    .all(snapshotId, like, q, limit);
}

export interface ContextSnippet { path: string; startLine: number; endLine: number; text: string; reason: string }

/**
 * Token-aware context retrieval for AI calls: ranks files by BM25 + symbol-name matches and
 * returns line windows around matches until the character budget (~4 chars/token) is used.
 */
export function retrieveContext(snapshotId: string, root: string, query: string, opts: { budgetChars?: number; maxFiles?: number; mustInclude?: { path: string; line?: number }[] } = {}): ContextSnippet[] {
  const budget = opts.budgetChars ?? 40_000;
  const maxFiles = opts.maxFiles ?? 12;
  const out: ContextSnippet[] = [];
  let used = 0;
  const readLines = (rel: string): string[] | null => {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(path.resolve(root) + path.sep)) return null;
    try {
      return fs.readFileSync(abs, "utf8").split("\n");
    } catch {
      return null;
    }
  };
  const pushWindow = (rel: string, center: number, radius: number, reason: string) => {
    const lines = readLines(rel);
    if (!lines) return;
    const s = Math.max(1, center - radius);
    const e = Math.min(lines.length, center + radius);
    if (out.some((o) => o.path === rel && !(e < o.startLine || s > o.endLine))) return;
    const text = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}| ${l}`).join("\n");
    if (used + text.length > budget) return;
    used += text.length;
    out.push({ path: rel, startLine: s, endLine: e, text, reason });
  };
  for (const m of opts.mustInclude ?? []) pushWindow(m.path, m.line ?? 1, m.line ? 30 : 60, "referenced directly");
  const syms = searchSymbols(snapshotId, queryTerms(query).sort((a, b) => b.length - a.length)[0] ?? query, 8) as any[];
  for (const s of syms.slice(0, 4)) pushWindow(s.path, Math.round((s.line + s.end_line) / 2), Math.min(60, Math.max(15, Math.round((s.end_line - s.line) / 2) + 5)), `symbol ${s.name}`);
  const hits = searchCode(snapshotId, query, { limit: maxFiles });
  for (const h of hits) {
    if (out.length >= maxFiles + 4) break;
    const first = h.matches[0];
    pushWindow(h.path, first?.line ?? 1, 25, "text match");
  }
  return out;
}

export function formatContext(snips: ContextSnippet[]): string {
  return snips.map((s) => `<file path="${s.path}" lines="${s.startLine}-${s.endLine}">\n${s.text}\n</file>`).join("\n\n");
}

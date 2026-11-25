import fs from "node:fs";
import path from "node:path";
import { db, now, json } from "../db/db.js";
import { registerHandler, type JobCtx } from "../jobs/queue.js";
import { getRepo, repoDir } from "./analysis.js";
import { retrieveContext, formatContext, searchCode } from "./search.js";
import { providerFor, parseJson } from "../ai/provider.js";
import { run } from "../engine/external.js";
import { publish } from "../lib/events.js";
import { audit, notify } from "../lib/audit.js";

export interface Frame { file: string; line: number | null; fn: string | null; raw: string; repoPath?: string | null }

/** Step 1-2: parse the incident text into structured error details. */
export function parseIncident(input: { error?: string; stackTrace?: string; logs?: string; failingTests?: string; description?: string }) {
  const all = [input.error, input.stackTrace, input.logs, input.failingTests].filter(Boolean).join("\n");
  const frames: Frame[] = [];
  for (const line of all.split("\n")) {
    let m = line.match(/^\s*at (?:async )?(?:(.+?) \()?((?:file:\/\/)?[^():\s]+):(\d+):(\d+)\)?\s*$/);
    if (m) { frames.push({ fn: m[1] ?? null, file: m[2].replace(/^file:\/\//, ""), line: Number(m[3]), raw: line.trim() }); continue; }
    m = line.match(/^\s*File "([^"]+)", line (\d+)(?:, in (.+))?/);
    if (m) { frames.push({ file: m[1], line: Number(m[2]), fn: m[3]?.trim() ?? null, raw: line.trim() }); continue; }
    m = line.match(/^\s*([\w./-]+\.(?:go|rs|java|rb|php|kt|cs)):(\d+)/);
    if (m) frames.push({ file: m[1], line: Number(m[2]), fn: null, raw: line.trim() });
  }
  const errLine = (input.error || all.split("\n").find((l) => /(Error|Exception|panic|FAIL|Traceback)/.test(l)) || "").trim();
  const typeMatch = errLine.match(/\b([A-Z][A-Za-z]*(?:Error|Exception|Warning))\b:?\s*(.*)/);
  const errorType = typeMatch?.[1] ?? (/panic:/.test(errLine) ? "panic" : null);
  const message = typeMatch?.[2] ?? errLine;
  const failingTests = (input.failingTests ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 30);
  const logErrors = (input.logs ?? "").split("\n").filter((l) => /\b(ERROR|FATAL|CRITICAL|Exception|Traceback)\b/.test(l)).slice(0, 20);
  const identifiers = [...new Set((message.match(/['"`]?([A-Za-z_][\w.]{2,})['"`]?/g) ?? []).map((s) => s.replace(/['"`]/g, "")))].slice(0, 10);
  return { errorType, message: message.slice(0, 500), frames: frames.slice(0, 40), failingTests, logErrors, identifiers };
}

function mapFramesToRepo(frames: Frame[], files: string[]): Frame[] {
  return frames.map((f) => {
    const norm = f.file.replace(/\\/g, "/");
    const hit = files.find((p) => norm.endsWith("/" + p) || norm === p) ?? files.filter((p) => norm.endsWith(p.split("/").slice(-2).join("/"))).sort((a, b) => b.length - a.length)[0] ?? null;
    return { ...f, repoPath: hit };
  });
}

const HEURISTICS: { test: RegExp; title: string; explain: string; fix: string }[] = [
  { test: /Cannot read propert(y|ies) of (undefined|null)|undefined is not an object|null is not an object|'NoneType' object (has no attribute|is not subscriptable)/i, title: "Null/undefined dereference", explain: "A value expected to be an object is null/undefined/None at the failing line; the property access throws.", fix: "Guard the access (optional chaining / explicit check) and trace why the value is missing upstream (failed lookup, async race, missing field in payload)." },
  { test: /is not a function|object is not callable/i, title: "Calling a non-function", explain: "The callee is undefined or a different type — often a wrong import/export name, a missing method, or a shadowed variable.", fix: "Verify the import/export names and the object's shape at runtime." },
  { test: /Cannot find module|ModuleNotFoundError|ImportError|ERR_MODULE_NOT_FOUND/i, title: "Module resolution failure", explain: "A module path or package cannot be resolved at runtime.", fix: "Fix the import path or install/declare the dependency." },
  { test: /KeyError|has no key|undefined index/i, title: "Missing dictionary key", explain: "Code assumes a key exists in a mapping.", fix: "Use `.get()` with a default or validate input shape." },
  { test: /IndexError|out of range|RangeError/i, title: "Index / range violation", explain: "An index or size exceeded valid bounds — often an empty collection or off-by-one.", fix: "Check collection length and loop bounds." },
  { test: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Connection refused|timed out/i, title: "External dependency unavailable", explain: "A network service (DB, API) was unreachable or slow.", fix: "Check service health/configuration; add timeouts, retries and error handling." },
  { test: /UnhandledPromiseRejection|unhandled rejection/i, title: "Unhandled promise rejection", explain: "A promise rejected with no handler — often a missing await or a fire-and-forget call.", fix: "Await the promise or attach a .catch handler." },
  { test: /deadlock|lock wait timeout|database is locked/i, title: "Lock contention", explain: "Concurrent transactions contended for the same lock.", fix: "Shorten transactions, order lock acquisition consistently, add retry." },
  { test: /TypeError/i, title: "Type mismatch", explain: "A value had an unexpected type at runtime.", fix: "Validate inputs at boundaries and align types." },
  { test: /AssertionError|expect\(|Expected .* (to|but)/i, title: "Assertion failure", explain: "A test assertion or runtime invariant failed — behaviour differs from expectation.", fix: "Compare the asserted value with actual behaviour; determine whether code or test expectation is wrong." },
];

const HYP_SCHEMA = {
  type: "object", additionalProperties: false, required: ["hypotheses", "proposed_fix"],
  properties: {
    hypotheses: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "explanation", "confidence", "evidence", "files"], properties: {
      title: { type: "string" }, explanation: { type: "string" }, confidence: { type: "number" },
      evidence: { type: "array", items: { type: "string" } }, files: { type: "array", items: { type: "string" } } } } },
    proposed_fix: { type: "object", additionalProperties: false, required: ["summary", "patch", "tests"], properties: { summary: { type: "string" }, patch: { type: "string" }, tests: { type: "string" } } },
  },
};

async function investigate(ctx: JobCtx) {
  const { investigationId } = ctx.payload as { investigationId: string };
  const inv = db().prepare(`SELECT * FROM investigations WHERE id = ?`).get(investigationId) as any;
  const repo = getRepo(ctx.workspaceId, inv.repository_id);
  if (!repo?.current_snapshot_id) throw new Error("Repository is not indexed");
  const root = repoDir(repo.id);
  const input = json<any>(inv.input, {});
  const timeline: { step: string; status: string; detail: string; at: string }[] = [];
  const save = (patch: Record<string, unknown>) => {
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(", ");
    db().prepare(`UPDATE investigations SET ${sets}, updated_at = ? WHERE id = ?`).run(...Object.values(patch).map((v) => (typeof v === "string" || v === null || typeof v === "number" ? v : JSON.stringify(v))), now(), investigationId);
    publish(ctx.workspaceId, { type: "investigation", id: investigationId, status: (patch.status as string) ?? undefined });
  };
  const step = (s: string, detail: string, status = "done") => {
    timeline.push({ step: s, status, detail, at: now() });
    ctx.log(`${s}: ${detail}`);
    save({ timeline, status: "running" });
  };

  // 1-2
  const parsed = parseIncident(input);
  const files = (db().prepare(`SELECT path FROM files WHERE snapshot_id = ?`).all(repo.current_snapshot_id) as { path: string }[]).map((r) => r.path);
  parsed.frames = mapFramesToRepo(parsed.frames, files);
  save({ parsed });
  step("Parse incident", `${parsed.errorType ?? "Unknown error type"}; ${parsed.frames.length} stack frames; ${parsed.failingTests.length} failing tests`);

  // 3. affected files
  const affected = new Map<string, { path: string; reasons: string[]; lines: number[] }>();
  const addAffected = (p: string, reason: string, line?: number | null) => {
    if (!affected.has(p)) affected.set(p, { path: p, reasons: [], lines: [] });
    const a = affected.get(p)!;
    if (!a.reasons.includes(reason)) a.reasons.push(reason);
    if (line) a.lines.push(line);
  };
  for (const f of parsed.frames) if (f.repoPath) addAffected(f.repoPath, "stack frame", f.line);
  const q = [parsed.message, input.description ?? "", ...parsed.identifiers].join(" ").slice(0, 300);
  for (const h of searchCode(repo.current_snapshot_id, q, { limit: 6 })) if (affected.size < 12) addAffected(h.path, "matches error text", h.matches[0]?.line);
  for (const t of parsed.failingTests) for (const h of searchCode(repo.current_snapshot_id, t, { limit: 2 })) addAffected(h.path, "failing test reference", h.matches[0]?.line);
  step("Identify affected files", affected.size ? [...affected.keys()].slice(0, 8).join(", ") : "No repository files could be linked to the incident");

  // 4. relevant code
  const snippets = retrieveContext(repo.current_snapshot_id, root, q, { budgetChars: 30_000, mustInclude: [...affected.values()].slice(0, 6).map((a) => ({ path: a.path, line: a.lines[0] })) });
  step("Retrieve relevant code", `${snippets.length} code windows (${snippets.reduce((a, s) => a + s.endLine - s.startLine + 1, 0)} lines)`);

  // 5. call chains: who calls the functions in the top frames
  const chains: { function: string; file: string; callers: { file: string; caller: string | null; line: number }[] }[] = [];
  for (const f of parsed.frames.filter((x) => x.repoPath).slice(0, 5)) {
    const sym = db().prepare(`SELECT s.name FROM symbols s JOIN files fl ON fl.id = s.file_id WHERE s.snapshot_id = ? AND fl.path = ? AND s.line <= ? AND s.end_line >= ? AND s.kind IN ('function','method','component') ORDER BY (s.end_line - s.line) LIMIT 1`).get(repo.current_snapshot_id, f.repoPath, f.line ?? 0, f.line ?? 0) as any;
    if (!sym) continue;
    const callers = db().prepare(`SELECT sf.path AS file, e.source_symbol AS caller, e.line FROM edges e JOIN files sf ON sf.id = e.source_file_id JOIN files tf ON tf.id = e.target_file_id WHERE e.snapshot_id = ? AND e.kind = 'call' AND e.target_symbol = ? AND tf.path = ? LIMIT 15`).all(repo.current_snapshot_id, sym.name, f.repoPath) as any[];
    chains.push({ function: sym.name, file: f.repoPath!, callers });
  }
  step("Analyze call chains", chains.length ? chains.map((c) => `${c.function} ← ${c.callers.length} callers`).join("; ") : "No resolvable functions in stack frames");

  // 6. dependency paths
  const depPaths: { file: string; imports: string[]; importedBy: string[] }[] = [];
  for (const a of [...affected.values()].slice(0, 6)) {
    const imports = (db().prepare(`SELECT COALESCE(tf.path, e.target_external) AS t FROM edges e JOIN files sf ON sf.id = e.source_file_id LEFT JOIN files tf ON tf.id = e.target_file_id WHERE e.snapshot_id = ? AND e.kind = 'import' AND sf.path = ?`).all(repo.current_snapshot_id, a.path) as any[]).map((r) => r.t);
    const importedBy = (db().prepare(`SELECT sf.path AS s FROM edges e JOIN files sf ON sf.id = e.source_file_id JOIN files tf ON tf.id = e.target_file_id WHERE e.snapshot_id = ? AND e.kind = 'import' AND tf.path = ?`).all(repo.current_snapshot_id, a.path) as any[]).map((r) => r.s);
    depPaths.push({ file: a.path, imports: [...new Set(imports)].slice(0, 20), importedBy: [...new Set(importedBy)].slice(0, 20) });
  }
  step("Map dependencies", `${depPaths.reduce((a, d) => a + d.importedBy.length, 0)} dependents of affected files (impact radius)`);

  // 9 (collected early): evidence — frames, existing findings, recent commits
  const evidence: { kind: string; title: string; detail: string; file?: string; line?: number }[] = [];
  for (const f of parsed.frames.filter((x) => x.repoPath).slice(0, 6)) {
    const lines = fs.existsSync(path.join(root, f.repoPath!)) ? fs.readFileSync(path.join(root, f.repoPath!), "utf8").split("\n") : [];
    evidence.push({ kind: "stack_frame", title: `${f.fn ?? "frame"} at ${f.repoPath}:${f.line}`, detail: lines[(f.line ?? 1) - 1]?.trim() ?? "", file: f.repoPath!, line: f.line ?? undefined });
  }
  const affectedPaths = [...affected.keys()];
  if (affectedPaths.length) {
    const rel = db().prepare(`SELECT id, title, severity, file_path, line, rule_id FROM findings WHERE repository_id = ? AND status IN ('open','triaged','in_progress') AND review_id IS NULL AND file_path IN (${affectedPaths.map(() => "?").join(",")}) ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 15`).all(repo.id, ...affectedPaths) as any[];
    for (const r of rel) evidence.push({ kind: "finding", title: `[${r.severity}] ${r.title}`, detail: `Existing static-analysis finding ${r.id} (${r.rule_id})`, file: r.file_path, line: r.line });
  }
  if (fs.existsSync(path.join(root, ".git"))) {
    for (const p of affectedPaths.slice(0, 4)) {
      const r = await run("git", ["-c", "core.hooksPath=/dev/null", "log", "-3", "--format=%h %aI %an: %s", "--", p], { cwd: root, timeoutMs: 10_000 });
      for (const l of r.stdout.split("\n").filter(Boolean)) evidence.push({ kind: "commit", title: l.slice(0, 160), detail: `Recent change to ${p}`, file: p });
    }
  }
  step("Collect evidence", `${evidence.length} evidence items`);

  // 7-8. hypotheses: deterministic heuristics first (evidence-linked), then AI
  const hypotheses: any[] = [];
  const text = [parsed.errorType, parsed.message, input.logs ?? ""].join(" ");
  const top = parsed.frames.find((f) => f.repoPath);
  for (const h of HEURISTICS) {
    if (!h.test.test(text)) continue;
    hypotheses.push({
      id: `h${hypotheses.length + 1}`, title: h.title + (top ? ` in ${top.fn ?? path.basename(top.repoPath!)}` : ""), explanation: h.explain, recommendation: h.fix,
      confidence: top ? 0.6 : 0.35, origin: "rule", evidence: [parsed.errorType ? `Error type ${parsed.errorType}: ${parsed.message.slice(0, 160)}` : parsed.message.slice(0, 160), ...(top ? [`Top in-repo frame ${top.repoPath}:${top.line}`] : [])],
      files: top?.repoPath ? [top.repoPath] : [], verification: top ? "supported: error signature matches and the failing line was located" : "unverified: no in-repo frame located",
    });
    break;
  }
  for (const e of evidence.filter((x) => x.kind === "finding").slice(0, 3)) {
    hypotheses.push({ id: `h${hypotheses.length + 1}`, title: `Known issue near failure: ${e.title.replace(/^\[\w+\] /, "")}`, explanation: `Static analysis previously flagged ${e.file}:${e.line ?? "?"}, which is part of the affected code.`, recommendation: "Review this finding; it may be the defect or a contributing factor.", confidence: 0.3, origin: "finding", evidence: [e.detail], files: e.file ? [e.file] : [], verification: "supported by a detected finding at an affected location" });
  }
  let proposed: any = null;
  const ai = providerFor(ctx.workspaceId, ctx.userId);
  if (ai) {
    step("Generate hypotheses (AI)", "Requesting ranked hypotheses from Claude with retrieved code and evidence", "running");
    try {
      const resp = await ai.complete({
        feature: "investigation",
        signal: ctx.signal,
        jsonSchema: HYP_SCHEMA,
        system: "You are DevForge's Root Cause Engineer. Using ONLY the provided incident data, code (with line numbers) and evidence, produce ranked root-cause hypotheses. Every hypothesis must cite concrete evidence (file:line, log line, or frame). Confidence is 0..1. Do not invent files. Then propose a minimal fix as a unified diff against the shown code, plus a regression test outline. If evidence is insufficient, say so and keep confidence low.",
        messages: [{ role: "user", content: `Incident title: ${inv.title}\nDescription: ${input.description ?? "(none)"}\nError: ${parsed.errorType ?? ""} ${parsed.message}\nStack frames:\n${parsed.frames.slice(0, 15).map((f) => `${f.raw}${f.repoPath ? `  -> ${f.repoPath}` : ""}`).join("\n")}\nFailing tests:\n${parsed.failingTests.join("\n") || "(none)"}\nLog errors:\n${parsed.logErrors.join("\n") || "(none)"}\n\nCall chains:\n${JSON.stringify(chains).slice(0, 3000)}\n\nEvidence:\n${evidence.map((e) => `- ${e.title}: ${e.detail}`).join("\n").slice(0, 4000)}\n\nCode:\n${formatContext(snippets)}` }],
      });
      const out = parseJson<{ hypotheses: any[]; proposed_fix: any }>(resp.text);
      for (const h of out.hypotheses.slice(0, 6)) {
        hypotheses.push({ id: `h${hypotheses.length + 1}`, title: h.title, explanation: h.explanation, confidence: Math.max(0, Math.min(1, Number(h.confidence) || 0)), origin: "ai_hypothesis", evidence: h.evidence, files: (h.files ?? []).filter((f: string) => files.includes(f)), verification: (h.files ?? []).every((f: string) => files.includes(f)) ? "unverified: AI hypothesis (cited files exist)" : "unverified: AI hypothesis (some cited files not found in repository)" });
      }
      proposed = { ...out.proposed_fix, origin: "ai", applied: false, note: "AI-generated patch. Review before applying; DevForge never applies patches automatically." };
      db().prepare(`UPDATE investigations SET ai_used = 1 WHERE id = ?`).run(investigationId);
      step("Generate hypotheses (AI)", `${out.hypotheses.length} AI hypotheses`);
    } catch (e: any) {
      step("Generate hypotheses (AI)", `AI step failed: ${e.message}`, "failed");
    }
  } else {
    step("Generate hypotheses (AI)", "Skipped — no AI provider configured. Rule-based hypotheses only.", "skipped");
  }
  hypotheses.sort((a, b) => b.confidence - a.confidence);
  step("Rank hypotheses", hypotheses.length ? `Top: ${hypotheses[0].title} (${Math.round(hypotheses[0].confidence * 100)}%)` : "No hypotheses could be formed from the available evidence");

  // 10-12
  if (!proposed && hypotheses[0]?.recommendation) proposed = { summary: hypotheses[0].recommendation, patch: "", tests: `Add a regression test reproducing: ${parsed.errorType ?? "the error"} — ${parsed.message.slice(0, 120)}`, origin: "rule", applied: false };
  step("Recommend fix", proposed ? proposed.summary.slice(0, 200) : "No fix recommendation");
  const verification = {
    reproducible: parsed.failingTests.length > 0 ? "Failing tests provided — re-run them in Test Forge after applying the fix." : "No failing test provided — generate a regression test in Test Forge.",
    hypothesisChecks: hypotheses.map((h) => ({ id: h.id, status: h.verification })),
  };
  step("Generate tests", "Regression test outline prepared; run Test Forge on the affected function to execute it");
  step("Verify hypotheses", `${hypotheses.filter((h) => h.verification.startsWith("supported")).length} supported by static evidence, ${hypotheses.filter((h) => h.verification.startsWith("unverified")).length} unverified`);
  save({ status: "completed", affected: [...affected.values()], hypotheses, evidence: { items: evidence, chains, depPaths, snippets: snippets.map((s) => ({ path: s.path, startLine: s.startLine, endLine: s.endLine, reason: s.reason })) }, proposed_fix: proposed, verification, timeline });
  audit({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: "investigation.completed", entityType: "investigation", entityId: investigationId });
  notify({ workspaceId: ctx.workspaceId, userId: ctx.userId ?? undefined, kind: "investigation", title: `Investigation complete: ${inv.title}`, link: `/app/investigations/${investigationId}` });
  return { hypotheses: hypotheses.length };
}

registerHandler("investigation.run", async (ctx) => {
  try {
    return await investigate(ctx);
  } catch (e: any) {
    db().prepare(`UPDATE investigations SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(String(e.message).slice(0, 500), now(), ctx.payload.investigationId);
    publish(ctx.workspaceId, { type: "investigation", id: ctx.payload.investigationId, status: "failed" });
    throw e;
  }
});

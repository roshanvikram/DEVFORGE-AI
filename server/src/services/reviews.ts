import fs from "node:fs";
import path from "node:path";
import { db, now, json } from "../db/db.js";
import { registerHandler, type JobCtx } from "../jobs/queue.js";
import { getRepo, repoDir } from "./analysis.js";
import { gitShow, gitDiff } from "../engine/ingest.js";
import { run } from "../engine/external.js";
import { runPatternRules, runSecretRules } from "../engine/rules/patterns.js";
import { parseTsFile } from "../engine/parse-ts.js";
import { detectLanguage, isTestPath } from "../engine/languages.js";
import type { RawFinding } from "../engine/types.js";
import { persistFindings } from "./findings.js";
import { providerFor, parseJson } from "../ai/provider.js";
import { retrieveContext, formatContext } from "./search.js";
import { gh, parseGithubSlug } from "./github.js";
import { publish } from "../lib/events.js";
import { audit, notify } from "../lib/audit.js";

export interface DiffFile { path: string; oldPath: string | null; status: "added" | "modified" | "deleted" | "renamed"; added: { line: number; text: string }[]; removed: { line: number; text: string }[]; additions: number; deletions: number }

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let newLine = 0;
  let oldLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      cur = { path: m?.[2] ?? "", oldPath: m?.[1] ?? null, status: "modified", added: [], removed: [], additions: 0, deletions: 0 };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("rename from")) cur.status = "renamed";
    else if (line.startsWith("+++ ")) { if (line !== "+++ /dev/null") cur.path = line.slice(4).replace(/^b\//, ""); }
    else if (line.startsWith("--- ")) { /* old path */ }
    else if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLine = Number(m?.[1] ?? 0);
      newLine = Number(m?.[2] ?? 0);
    } else if (line.startsWith("+")) { cur.added.push({ line: newLine++, text: line.slice(1) }); cur.additions++; }
    else if (line.startsWith("-")) { cur.removed.push({ line: oldLine++, text: line.slice(1) }); cur.deletions++; }
    else if (line.startsWith(" ")) { newLine++; oldLine++; }
  }
  return files;
}

const REVIEW_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "category", "severity", "file", "line", "evidence", "explanation", "impact", "recommendation", "suggested_patch"], properties: {
      title: { type: "string" }, category: { type: "string", enum: ["Bugs", "Security", "Performance", "Regressions", "Maintainability", "Breaking changes", "Test coverage", "Architecture impact"] },
      severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] }, file: { type: "string" }, line: { type: "integer" },
      evidence: { type: "string" }, explanation: { type: "string" }, impact: { type: "string" }, recommendation: { type: "string" }, suggested_patch: { type: "string" } } } },
  },
};

async function fileAtRef(root: string, ref: string | null, p: string): Promise<string | null> {
  if (ref && /^[\w./~^-]{1,100}$/.test(ref)) {
    const r = await run("git", ["-c", "core.hooksPath=/dev/null", "show", `${ref}:${p}`], { cwd: root, timeoutMs: 10_000, maxBytes: 2_000_000 });
    if (r.code === 0) return r.stdout;
  }
  const abs = path.resolve(root, p);
  if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, "utf8");
}

/** Deterministic review of a diff: rules on added lines + structural risk checks. */
export async function staticReview(repo: any, files: DiffFile[], headRef: string | null): Promise<{ findings: RawFinding[]; risk: any }> {
  const root = repoDir(repo.id);
  const findings: RawFinding[] = [];
  for (const f of files) {
    if (f.status === "deleted") continue;
    const language = detectLanguage(f.path);
    const addedSet = new Set(f.added.map((a) => a.line));
    const isTest = isTestPath(f.path);
    const content = await fileAtRef(root, headRef, f.path);
    if (content != null) {
      const fileObj = { path: f.path, language, content, isTest };
      const all = [...runPatternRules(fileObj), ...runSecretRules(fileObj)];
      if (language === "typescript" || language === "javascript") {
        try {
          all.push(...parseTsFile(f.path, content, isTest).findings.filter((x) => x.source === "bug" || x.source === "performance"));
        } catch { /* parse failure */ }
      }
      for (const x of all) if (x.line && addedSet.has(x.line)) findings.push({ ...x, source: "review", category: x.source === "security" || x.source === "secret" ? "Security" : x.source === "performance" ? "Performance" : "Bugs", evidence: `Introduced in this change. ${x.evidence}` });
    }
    // Breaking changes: removed exported declarations not re-added
    const declRe = /^\s*(export\s+(default\s+)?(async\s+)?(function|class|const|interface|type)\s+(\w+)|def\s+([a-zA-Z]\w*)\s*\()/;
    const addedNames = new Set(f.added.map((a) => a.text.match(declRe)).filter(Boolean).map((m) => m![5] ?? m![6]));
    for (const r of f.removed) {
      const m = r.text.match(declRe);
      const name = m?.[5] ?? m?.[6];
      if (!name || addedNames.has(name)) continue;
      const dependents = db().prepare(`SELECT COUNT(DISTINCT e.source_file_id) AS n FROM edges e JOIN files tf ON tf.id = e.target_file_id WHERE e.snapshot_id = ? AND tf.path = ? AND (e.target_symbol LIKE ? OR e.target_symbol = ?)`).get(repo.current_snapshot_id, f.path, `%${name}%`, name) as any;
      findings.push({
        source: "review", tool: "devforge-review", rule_id: "review/removed-export", title: `Exported symbol "${name}" removed`, category: "Breaking changes", severity: dependents?.n ? "high" : "medium", confidence: "medium",
        file_path: f.path, line: null, snippet: r.text.trim().slice(0, 300),
        evidence: `The declaration of "${name}" was deleted and not re-added in this change.${dependents?.n ? ` ${dependents.n} file(s) in the indexed snapshot import it.` : ""}`,
        explanation: "Removing a public symbol breaks callers that still reference it.", impact: dependents?.n ? `${dependents.n} dependent module(s) may fail to build or run.` : "External consumers may break.",
        recommendation: "Keep a deprecated alias, or update all callers in the same change.", verification: "Build and run dependent modules' tests.",
      });
    }
  }
  const srcChanged = files.filter((f) => !isTestPath(f.path) && f.status !== "deleted" && /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php)$/.test(f.path));
  const testsChanged = files.filter((f) => isTestPath(f.path));
  if (srcChanged.reduce((a, f) => a + f.additions, 0) > 20 && !testsChanged.length) {
    findings.push({
      source: "review", tool: "devforge-review", rule_id: "review/no-tests", title: "Source changes without test changes", category: "Test coverage", severity: "medium", confidence: "high",
      file_path: srcChanged[0].path, line: null, evidence: `${srcChanged.length} source files changed (+${srcChanged.reduce((a, f) => a + f.additions, 0)} lines) and no test files were modified.`,
      explanation: "New or changed behaviour is not accompanied by tests.", impact: "Regressions in this change will not be caught automatically.",
      recommendation: "Add or update tests covering the changed behaviour (Test Forge can generate them).", verification: "Tests touching the changed files are present and pass.",
    });
  }
  // hotspot impact: fan-in of changed files
  const hotspots = srcChanged.map((f) => {
    const r = db().prepare(`SELECT COUNT(DISTINCT e.source_file_id) AS n FROM edges e JOIN files tf ON tf.id = e.target_file_id WHERE e.snapshot_id = ? AND e.kind = 'import' AND tf.path = ?`).get(repo.current_snapshot_id, f.path) as any;
    return { path: f.path, dependents: r?.n ?? 0 };
  }).sort((a, b) => b.dependents - a.dependents);
  for (const h of hotspots.filter((h) => h.dependents >= 10).slice(0, 3)) {
    findings.push({ source: "review", tool: "devforge-review", rule_id: "review/hotspot", title: `High-impact module changed: ${h.path}`, category: "Architecture impact", severity: "low", confidence: "high", file_path: h.path, line: null,
      evidence: `${h.dependents} modules import ${h.path}.`, explanation: "Changes to widely imported modules have a large blast radius.", impact: `Behaviour changes propagate to ${h.dependents} dependents.`, recommendation: "Request review from owners of dependent areas and run the broader test suite.", verification: "Dependent modules' tests pass." });
  }
  const additions = files.reduce((a, f) => a + f.additions, 0);
  const deletions = files.reduce((a, f) => a + f.deletions, 0);
  const sevW: Record<string, number> = { critical: 30, high: 15, medium: 6, low: 2, info: 0 };
  const score = Math.min(100, Math.round(findings.reduce((a, f) => a + sevW[f.severity], 0) + Math.min(25, (additions + deletions) / 40) + Math.min(15, files.length) + Math.min(15, (hotspots[0]?.dependents ?? 0))));
  return { findings, risk: { score, additions, deletions, files: files.length, testsChanged: testsChanged.length, hotspots: hotspots.slice(0, 5) } };
}

async function suggestReviewers(root: string, paths: string[]) {
  if (!fs.existsSync(path.join(root, ".git"))) return [];
  const counts = new Map<string, number>();
  for (const p of paths.slice(0, 15)) {
    const r = await run("git", ["-c", "core.hooksPath=/dev/null", "log", "-20", "--format=%an", "--", p], { cwd: root, timeoutMs: 10_000 });
    for (const a of r.stdout.split("\n").filter(Boolean)) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, commits]) => ({ name, commits }));
}

async function reviewJob(ctx: JobCtx) {
  const { reviewId } = ctx.payload as { reviewId: string };
  const rv = db().prepare(`SELECT * FROM reviews WHERE id = ?`).get(reviewId) as any;
  const repo = getRepo(ctx.workspaceId, rv.repository_id);
  const root = repoDir(repo.id);
  const ref = json<any>(rv.ref, {});
  db().prepare(`UPDATE reviews SET status = 'running' WHERE id = ?`).run(reviewId);
  publish(ctx.workspaceId, { type: "review", id: reviewId, status: "running" });
  let diff = rv.diff as string | null;
  let headRef: string | null = null;
  if (rv.kind === "commit") { diff = await gitShow(root, ref.sha); headRef = ref.sha; }
  else if (rv.kind === "range") { diff = await gitDiff(root, ref.base, ref.head); headRef = ref.head; }
  else if (rv.kind === "pull_request") {
    const slug = parseGithubSlug(repo.source_url);
    if (!slug) throw new Error("Repository is not hosted on GitHub");
    diff = await gh(ctx.workspaceId, `/repos/${slug.owner}/${slug.repo}/pulls/${ref.number}`, { accept: "application/vnd.github.v3.diff" });
    headRef = null; // PR head is not checked out locally; rules use the diff text
  } else if (rv.kind === "repository") {
    diff = "";
  }
  if (diff && diff.length > 4_000_000) diff = diff.slice(0, 4_000_000);
  ctx.progress(0.2, "Analysing changes");
  const files = rv.kind === "snippet" ? [{ path: ref.path ?? "snippet.txt", oldPath: null, status: "added" as const, added: String(rv.diff ?? "").split("\n").map((t, i) => ({ line: i + 1, text: t })), removed: [], additions: String(rv.diff ?? "").split("\n").length, deletions: 0 }] : parseUnifiedDiff(diff ?? "");
  let findings: RawFinding[] = [];
  let risk: any = {};
  if (rv.kind === "pull_request" || rv.kind === "snippet") {
    // No checked-out head: run line rules over added lines directly.
    for (const f of files) {
      const language = detectLanguage(f.path);
      const content = f.added.map((a) => a.text);
      const pseudo = { path: f.path, language, content: content.join("\n"), isTest: isTestPath(f.path) };
      const map = f.added.map((a) => a.line);
      for (const x of [...runPatternRules(pseudo), ...runSecretRules(pseudo)]) findings.push({ ...x, source: "review", category: x.source === "performance" ? "Performance" : "Security", line: map[(x.line ?? 1) - 1] ?? x.line, evidence: `Introduced in this change. ${x.evidence}` });
    }
    const sr = await staticReview(repo, files.map((f) => ({ ...f, added: [] })), null).catch(() => ({ findings: [], risk: {} }));
    findings.push(...sr.findings);
    risk = sr.risk;
    const additions = files.reduce((a, f) => a + f.additions, 0);
    risk = { ...risk, additions, files: files.length };
  } else if (rv.kind !== "repository") {
    const sr = await staticReview(repo, files, headRef);
    findings = sr.findings;
    risk = sr.risk;
  }
  // AI review
  let summary = `${files.length} files changed (+${files.reduce((a, f) => a + f.additions, 0)} / -${files.reduce((a, f) => a + f.deletions, 0)}). ${findings.length} rule-based findings.`;
  const ai = providerFor(ctx.workspaceId, ctx.userId);
  let aiUsed = false;
  if (ai && (diff || rv.kind === "snippet")) {
    ctx.progress(0.5, "AI review");
    try {
      const ctxSnips = repo.current_snapshot_id ? retrieveContext(repo.current_snapshot_id, root, files.map((f) => path.basename(f.path)).join(" "), { budgetChars: 20_000, maxFiles: 6 }) : [];
      const body = rv.kind === "snippet" ? `File: ${ref.path ?? "(snippet)"}\n\n${rv.diff}` : (diff ?? "").slice(0, 120_000);
      const resp = await ai.complete({
        feature: "code_review",
        signal: ctx.signal,
        jsonSchema: REVIEW_SCHEMA,
        system: "You are DevForge's Code Reviewer. Review ONLY the changed lines in the diff for bugs, security, performance, regressions, maintainability, breaking changes, test coverage and architecture impact. Each finding must reference a file and a line in the NEW version that appears in the diff, quote the evidence, and give a concrete fix (suggested_patch as a small unified diff or empty string). Skip style nits. If the change looks correct, return few or no findings.",
        messages: [{ role: "user", content: `Change: ${rv.title}\n\nDiff:\n${body}\n\nRelated repository context:\n${formatContext(ctxSnips)}` }],
      });
      const out = parseJson<{ summary: string; findings: any[] }>(resp.text);
      const changedPaths = new Set(files.map((f) => f.path));
      for (const f of out.findings.slice(0, 40)) {
        findings.push({ source: "review", origin: "ai_hypothesis", tool: "claude", rule_id: `ai-review/${f.category.toLowerCase().replace(/\s+/g, "-")}`, title: f.title, category: f.category, severity: f.severity, confidence: changedPaths.has(f.file) ? "medium" : "low",
          file_path: f.file, line: f.line || null, evidence: f.evidence, explanation: f.explanation, impact: f.impact, recommendation: f.recommendation, suggested_patch: f.suggested_patch || null, verification: "AI hypothesis — confirm by reading the cited lines or adding a test." });
      }
      summary = out.summary + "\n\n" + summary;
      aiUsed = true;
    } catch (e: any) {
      ctx.log(`AI review failed: ${e.message}`, "warn");
      summary += ` AI review unavailable: ${e.message}`;
    }
  } else if (!ai) summary += " AI review skipped (no AI provider configured).";
  persistFindings({ workspaceId: repo.workspace_id, repositoryId: repo.id, reviewId, findings });
  const reviewers = await suggestReviewers(root, files.map((f) => f.path));
  const bySev: Record<string, number> = {};
  for (const f of findings) bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
  const sevW: Record<string, number> = { critical: 30, high: 15, medium: 6, low: 2, info: 0 };
  const score = Math.min(100, Math.max(risk.score ?? 0, Math.round(findings.reduce((a, f) => a + sevW[f.severity], 0))));
  db().prepare(`UPDATE reviews SET status = 'completed', diff = ?, summary = ?, risk_score = ?, ai_used = ?, finished_at = ? WHERE id = ?`)
    .run(rv.kind === "snippet" ? rv.diff : (diff ?? "").slice(0, 2_000_000), JSON.stringify({ text: summary, bySeverity: bySev, risk, reviewers, files: files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })) }), score, aiUsed ? 1 : 0, now(), reviewId);
  publish(ctx.workspaceId, { type: "review", id: reviewId, status: "completed" });
  audit({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: "review.completed", entityType: "review", entityId: reviewId, data: { findings: findings.length, risk: score } });
  notify({ workspaceId: ctx.workspaceId, userId: ctx.userId ?? undefined, kind: "review", title: `Review complete: ${rv.title}`, body: `Risk ${score}/100 · ${findings.length} findings`, link: `/app/reviews/${reviewId}` });
  return { findings: findings.length, risk: score };
}

registerHandler("review.run", async (ctx) => {
  try {
    return await reviewJob(ctx);
  } catch (e: any) {
    db().prepare(`UPDATE reviews SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(String(e.message).slice(0, 500), now(), ctx.payload.reviewId);
    publish(ctx.workspaceId, { type: "review", id: ctx.payload.reviewId, status: "failed" });
    throw e;
  }
});

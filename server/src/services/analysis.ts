import fs from "node:fs";
import path from "node:path";
import { db, now, json } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { config } from "../config.js";
import { registerHandler, type JobCtx } from "../jobs/queue.js";
import { cloneRepo, copyLocalRepo, gitPull, validateGitUrl, gitHead } from "../engine/ingest.js";
import { indexRepository, loadContext, reparse, type IndexContext } from "../engine/indexer.js";
import { runPatternRules, runSecretRules } from "../engine/rules/patterns.js";
import { debtForFile, todoFindings, duplicateFindings } from "../engine/rules/debt.js";
import { typecheckRepo } from "../engine/typecheck.js";
import { parseManifests, queryOsv, enrichRegistry, dependencyFindings } from "../engine/deps.js";
import { runRuff, runSemgrep, runGitleaks, runTrivy, runNpmAudit, runPipAudit, type ToolStatus } from "../engine/external.js";
import { stronglyConnected, cyclePath } from "../engine/graph.js";
import type { RawFinding, FindingSource } from "../engine/types.js";
import { persistFindings } from "./findings.js";
import { audit, notify } from "../lib/audit.js";
import { publish } from "../lib/events.js";
import { getGithubToken } from "./integrations.js";

export const SCAN_KINDS = ["bug", "security", "dependency", "performance", "debt"] as const;
export type ScanKind = (typeof SCAN_KINDS)[number];
export const PRESETS: Record<string, ScanKind[]> = {
  quick: ["bug", "security", "debt"],
  full: ["bug", "security", "dependency", "performance", "debt"],
  security: ["security", "dependency"],
  architecture: ["debt"],
  none: [],
};

const SOURCES_FOR: Record<ScanKind, FindingSource[]> = {
  bug: ["bug"],
  security: ["security", "secret"],
  dependency: ["dependency"],
  performance: ["performance"],
  debt: ["debt"],
};

export function repoDir(repoId: string) {
  return path.join(config.reposDir, repoId);
}

export function getRepo(workspaceId: string, repoId: string) {
  return db().prepare(`SELECT * FROM repositories WHERE id = ? AND workspace_id = ?`).get(repoId, workspaceId) as any;
}

function cycleFindings(snapshotId: string): RawFinding[] {
  const edges = db()
    .prepare(`SELECT sf.path AS s, tf.path AS t FROM edges e JOIN files sf ON sf.id = e.source_file_id JOIN files tf ON tf.id = e.target_file_id WHERE e.snapshot_id = ? AND e.kind = 'import'`)
    .all(snapshotId) as { s: string; t: string }[];
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.s === e.t) continue;
    if (!adj.has(e.s)) adj.set(e.s, []);
    adj.get(e.s)!.push(e.t);
  }
  const comps = stronglyConnected([...adj.keys()], adj);
  return comps.slice(0, 100).map((c) => {
    const p = cyclePath(c, adj);
    return {
      source: "debt" as const, tool: "devforge-graph", rule_id: "arch/circular-dependency", title: `Circular dependency between ${c.length} modules`, category: "Poor architecture",
      severity: c.length > 5 ? "medium" : "low", confidence: "high", file_path: p[0], line: null,
      evidence: `Import cycle: ${p.join(" → ")}`,
      explanation: "Modules in an import cycle cannot be understood, tested or loaded independently; load order becomes significant.",
      impact: "Initialisation bugs (undefined imports at load time), tight coupling, harder refactoring.",
      recommendation: "Break the cycle by extracting shared types/logic into a lower-level module or inverting a dependency.",
      verification: "Architecture graph shows no cycle among these modules.",
      related: c.slice(0, 20),
    };
  });
}

/** Runs the selected analyzers over an indexed snapshot and persists findings. */
export async function analyzeSnapshot(repo: any, ctx: IndexContext, kinds: ScanKind[], job: Pick<JobCtx, "log" | "progress" | "signal" | "userId" | "id">) {
  if (!kinds.length) return { scans: [] as any[] };
  if (!ctx.parse.size) await reparse(ctx, job.log);
  const cache = new Map<string, Promise<{ status: ToolStatus; findings: RawFinding[] }>>();
  const ruff = () => {
    if (!cache.has("ruff")) cache.set("ruff", ctx.files.some((f) => f.language === "python") ? runRuff(ctx.root) : Promise.resolve({ status: { status: "skipped", note: "No Python files", findings: 0 } as ToolStatus, findings: [] }));
    return cache.get("ruff")!;
  };
  const parsedFindings = [...ctx.parse.values()].flatMap((r) => r.findings);
  const results: any[] = [];
  let i = 0;
  for (const kind of kinds) {
    if (job.signal.aborted) throw new Error("cancelled");
    const scanId = newId("scn_");
    db().prepare(`INSERT INTO scans (id, workspace_id, repository_id, snapshot_id, job_id, kind, status, started_at, created_by) VALUES (?,?,?,?,?,?, 'running', ?, ?)`).run(scanId, repo.workspace_id, repo.id, ctx.snapshotId, job.id, kind, now(), job.userId);
    publish(repo.workspace_id, { type: "scan", id: scanId, kind, status: "running", repositoryId: repo.id });
    job.progress(0.6 + (0.38 * i) / kinds.length, `Running ${kind} analysis`);
    job.log(`▶ ${kind} analysis`);
    const tools: Record<string, ToolStatus> = {};
    let findings: RawFinding[] = [];
    try {
      if (kind === "bug") {
        findings.push(...parsedFindings.filter((f) => f.source === "bug"), ...ctx.indexFindings.filter((f) => f.source === "bug"));
        tools["devforge-ast"] = { status: "ok", note: `AST rules over ${ctx.parse.size} files`, findings: findings.length };
        const tc = typecheckRepo(ctx.root, ctx.files.map((f) => f.path));
        tools["typescript"] = { status: tc.status, note: tc.note, findings: tc.findings.length };
        findings.push(...tc.findings);
        const r = await ruff();
        tools["ruff"] = r.status;
        findings.push(...r.findings.filter((f) => f.source === "bug"));
        tools["eslint"] = { status: "skipped", note: "ESLint loads repository config files (executable code); DevForge does not run it on the host. Use Test Forge's sandbox to run project linters.", findings: 0 };
      } else if (kind === "performance") {
        findings.push(...parsedFindings.filter((f) => f.source === "performance"));
        // Large client bundles / assets committed to the repo
        for (const f of ctx.files) {
          if (/\.(js|css)$/.test(f.path) && /(^|\/)(public|static|assets)\//.test(f.path) && f.size > 250 * 1024) {
            findings.push({ source: "performance", tool: "devforge-metrics", rule_id: "perf/large-static-asset", title: `Large static asset (${Math.round(f.size / 1024)} KB)`, category: "Large bundles", severity: "low", confidence: "high", file_path: f.path,
              evidence: `${f.path} is ${Math.round(f.size / 1024)} KB.`, explanation: "Large static scripts/styles increase page load time.", impact: "Slower first load, especially on mobile.", recommendation: "Minify, split, or lazy-load the asset; serve compressed.", verification: "Measure transfer size in the browser network panel." });
          }
        }
        tools["devforge-ast"] = { status: "ok", note: "Loop, query and blocking-I/O heuristics", findings: findings.length };
        const r = await ruff();
        findings.push(...r.findings.filter((f) => f.source === "performance"));
        tools["ruff"] = r.status;
        tools["benchmarks"] = { status: "skipped", note: "No benchmarks are run during static analysis; Performance Lab reports only static evidence.", findings: 0 };
      } else if (kind === "security") {
        for (const f of ctx.files) {
          findings.push(...runPatternRules(f), ...runSecretRules(f));
        }
        findings.push(...parsedFindings.filter((f) => f.source === "security"));
        tools["devforge-rules"] = { status: "ok", note: `Pattern rules over ${ctx.files.length} files`, findings: findings.filter((f) => f.tool === "devforge-rules").length };
        tools["devforge-secrets"] = { status: "ok", note: "Credential patterns (values masked)", findings: findings.filter((f) => f.tool === "devforge-secrets").length };
        const [sg, gl, tv, rf] = await Promise.all([runSemgrep(ctx.root), runGitleaks(ctx.root), runTrivy(ctx.root), ruff()]);
        tools.semgrep = sg.status; tools.gitleaks = gl.status; tools.trivy = tv.status; tools.ruff = rf.status;
        findings.push(...sg.findings, ...gl.findings, ...tv.findings, ...rf.findings.filter((f) => f.source === "security"));
      } else if (kind === "dependency") {
        const deps = parseManifests(ctx.root, ctx.manifests);
        job.log(`Found ${deps.length} declared dependencies in ${ctx.manifests.length} manifests`);
        tools["manifests"] = { status: deps.length ? "ok" : "skipped", note: `${deps.length} dependencies`, findings: 0 };
        const osv = await queryOsv(deps, job.log);
        tools["osv"] = { status: osv.status, note: osv.note, findings: deps.reduce((a, d) => a + (d.vulns?.length ?? 0), 0) };
        const reg = await enrichRegistry(deps, job.log);
        tools["registry"] = { status: reg.status, note: `Latest version/license for ${reg.checked} packages`, findings: 0 };
        findings.push(...dependencyFindings(deps));
        const [na, pa] = await Promise.all([
          runNpmAudit(ctx.root, ctx.manifests.filter((m) => m.endsWith("package-lock.json"))),
          runPipAudit(ctx.root, ctx.manifests.filter((m) => /requirements[^/]*\.txt$/.test(m))),
        ]);
        tools["npm-audit"] = na.status; tools["pip-audit"] = pa.status;
        findings.push(...na.findings, ...pa.findings);
        const ins = db().prepare(`INSERT INTO dependencies (id, snapshot_id, ecosystem, name, version_spec, resolved_version, manifest_path, dev, license, latest_version, vulns, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
        db().transaction(() => {
          db().prepare(`DELETE FROM dependencies WHERE snapshot_id = ?`).run(ctx.snapshotId);
          for (const dd of deps) ins.run(newId("dep_"), ctx.snapshotId, dd.ecosystem, dd.name, dd.version_spec, dd.resolved_version, dd.manifest_path, dd.dev ? 1 : 0, dd.license ?? null, dd.latest_version ?? null, JSON.stringify(dd.vulns ?? []), osv.status === "ok" ? now() : null);
        })();
      } else if (kind === "debt") {
        for (const f of ctx.files) {
          const r = ctx.parse.get(f.path);
          if (r) findings.push(...debtForFile(f, r.symbols));
          else if (f.language && ["go", "rust", "java", "ruby", "php", "csharp", "kotlin", "swift", "c", "cpp"].includes(f.language)) findings.push(...debtForFile(f, []));
          findings.push(...todoFindings(f));
        }
        findings.push(...duplicateFindings(ctx.files), ...cycleFindings(ctx.snapshotId));
        tools["devforge-metrics"] = { status: "ok", note: "Complexity, size, duplication, TODOs, cycles", findings: findings.length };
      }

      // Tools that failed or were not installed must not auto-resolve their old findings.
      const TOOL_ALIASES: Record<string, string[]> = {
        "devforge-ast": ["devforge-ast", "devforge-pyast", "devforge-resolver"],
        osv: ["osv.dev"],
        registry: ["registry-metadata"],
        manifests: ["devforge-deps"],
      };
      const coveredTools = Object.entries(tools)
        .filter(([, s]) => s.status === "ok")
        .flatMap(([k]) => TOOL_ALIASES[k] ?? [k]);
      if (kind === "debt") coveredTools.push("devforge-graph");
      if (kind === "dependency" && tools.manifests?.status !== "failed") coveredTools.push("devforge-deps");
      const persisted = persistFindings({ workspaceId: repo.workspace_id, repositoryId: repo.id, scanId, findings, coveredSources: SOURCES_FOR[kind], coveredTools });
      const bySev: Record<string, number> = {};
      for (const f of findings) bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
      const summary = { findings: persisted.total, created: persisted.created, autoResolved: persisted.autoResolved, bySeverity: bySev };
      db().prepare(`UPDATE scans SET status = 'completed', tools = ?, summary = ?, finished_at = ? WHERE id = ?`).run(JSON.stringify(tools), JSON.stringify(summary), now(), scanId);
      job.log(`✔ ${kind}: ${persisted.total} findings (${persisted.created} new, ${persisted.autoResolved} resolved)`);
      publish(repo.workspace_id, { type: "scan", id: scanId, kind, status: "completed", repositoryId: repo.id });
      results.push({ id: scanId, kind, ...summary, tools });
    } catch (e: any) {
      db().prepare(`UPDATE scans SET status = ?, tools = ?, error = ?, finished_at = ? WHERE id = ?`).run(job.signal.aborted ? "cancelled" : "failed", JSON.stringify(tools), String(e.message).slice(0, 500), now(), scanId);
      publish(repo.workspace_id, { type: "scan", id: scanId, kind, status: "failed", repositoryId: repo.id });
      if (job.signal.aborted) throw e;
      job.log(`✖ ${kind} analysis failed: ${e.message}`, "error");
      results.push({ id: scanId, kind, error: e.message });
    }
    i++;
  }
  return { scans: results };
}

/** Full pipeline: fetch (clone/pull/copy) → index → analyse. */
async function importAndAnalyze(ctx: JobCtx) {
  const { repositoryId, kinds = PRESETS.quick, refresh = false } = ctx.payload as { repositoryId: string; kinds?: ScanKind[]; refresh?: boolean };
  const repo = getRepo(ctx.workspaceId, repositoryId);
  if (!repo) throw new Error("Repository not found");
  const dir = repoDir(repo.id);
  const setStatus = (status: string, error: string | null = null) => {
    db().prepare(`UPDATE repositories SET status = ?, error = ? WHERE id = ?`).run(status, error, repo.id);
    publish(repo.workspace_id, { type: "repository", id: repo.id, status });
  };
  try {
    setStatus("importing");
    ctx.progress(0.02, "Fetching repository");
    let head: { sha: string | null; branch: string | null };
    const token = repo.source_type === "github" ? getGithubToken(repo.workspace_id) : null;
    if (refresh && fs.existsSync(path.join(dir, ".git")) && repo.source_type !== "local") {
      head = await gitPull(dir, token, ctx.log);
    } else if (repo.source_type === "local") {
      head = await copyLocalRepo(repo.source_url, dir, ctx.log);
    } else {
      const url = await validateGitUrl(repo.source_url);
      head = await cloneRepo(url, dir, { token, branch: repo.default_branch, log: ctx.log });
    }
    if (ctx.signal.aborted) throw new Error("cancelled");
    if (!head.sha) head = await gitHead(dir);
    setStatus("indexing");
    const ictx = await indexRepository(repo.id, dir, head, ctx.log, ctx.progress, ctx.signal);
    const prevSnapshot = repo.current_snapshot_id;
    const snapRow = db().prepare(`SELECT stats FROM snapshots WHERE id = ?`).get(ictx.snapshotId) as { stats: string } | undefined;
    const languages = json<any>(snapRow?.stats, {}).languages ?? {};
    db().prepare(`UPDATE repositories SET current_snapshot_id = ?, default_branch = COALESCE(default_branch, ?), languages = ?, frameworks = ?, last_analyzed_at = ? WHERE id = ?`)
      .run(ictx.snapshotId, head.branch, JSON.stringify(languages), JSON.stringify(ictx.frameworks), now(), repo.id);
    // Keep only the latest 5 snapshots' detailed index (files/symbols/edges cascade).
    const old = db().prepare(`SELECT id FROM snapshots WHERE repository_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 5`).all(repo.id) as { id: string }[];
    for (const o of old) {
      db().prepare(`DELETE FROM code_fts WHERE snapshot_id = ?`).run(o.id);
      db().prepare(`DELETE FROM snapshots WHERE id = ?`).run(o.id);
    }
    if (prevSnapshot) db().prepare(`DELETE FROM code_fts WHERE snapshot_id = ?`).run(prevSnapshot);
    ctx.progress(0.58, "Index complete");
    const result = await analyzeSnapshot({ ...repo, current_snapshot_id: ictx.snapshotId }, ictx, kinds, ctx);
    setStatus("ready");
    ctx.progress(1, "Analysis complete");
    audit({ workspaceId: repo.workspace_id, actorId: ctx.userId, actorType: "system", action: "repository.analyzed", entityType: "repository", entityId: repo.id, data: { kinds, snapshotId: ictx.snapshotId } });
    const newFindings = result.scans.reduce((a: number, s: any) => a + (s.created ?? 0), 0);
    notify({ workspaceId: repo.workspace_id, kind: "analysis", title: `Analysis finished: ${repo.name}`, body: `${result.scans.length} scans, ${newFindings} new findings`, link: `/app/repository?repo=${repo.id}` });
    return { snapshotId: ictx.snapshotId, files: ictx.files.length, ...result };
  } catch (e: any) {
    setStatus(repo.current_snapshot_id ? "ready" : "failed", ctx.signal.aborted ? "Cancelled" : String(e.message).slice(0, 500));
    throw e;
  }
}

async function analyzeExisting(ctx: JobCtx) {
  const { repositoryId, kinds } = ctx.payload as { repositoryId: string; kinds: ScanKind[] };
  const repo = getRepo(ctx.workspaceId, repositoryId);
  if (!repo?.current_snapshot_id) throw new Error("Repository has not been indexed yet");
  ctx.progress(0.05, "Loading index");
  const ictx = loadContext(repo.current_snapshot_id, repoDir(repo.id));
  const res = await analyzeSnapshot(repo, ictx, kinds, { ...ctx, progress: (p, m) => ctx.progress(Math.max(0.05, (p - 0.6) / 0.4), m) });
  db().prepare(`UPDATE repositories SET last_analyzed_at = ? WHERE id = ?`).run(now(), repo.id);
  audit({ workspaceId: repo.workspace_id, actorId: ctx.userId, action: "repository.scanned", entityType: "repository", entityId: repo.id, data: { kinds } });
  const created = res.scans.reduce((a: number, s: any) => a + (s.created ?? 0), 0);
  notify({ workspaceId: repo.workspace_id, kind: "scan", title: `${kinds.join(", ")} scan finished: ${repo.name}`, body: `${created} new findings`, link: `/app/bugs?repo=${repo.id}` });
  return res;
}

registerHandler("repo.import", importAndAnalyze);
registerHandler("repo.analyze", analyzeExisting);

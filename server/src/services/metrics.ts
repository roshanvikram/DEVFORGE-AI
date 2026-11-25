import { db, json } from "../db/db.js";
import { stronglyConnected, cyclePath } from "../engine/graph.js";

/**
 * Metrics derived only from recorded data (snapshots, findings, scans, runs).
 * When there is no data, values are null — never estimated.
 */
const SEV_WEIGHT: Record<string, number> = { critical: 25, high: 10, medium: 4, low: 1, info: 0 };

export function healthScore(repoId: string): { score: number | null; breakdown: Record<string, number> } {
  const repo = db().prepare(`SELECT current_snapshot_id FROM repositories WHERE id = ?`).get(repoId) as any;
  if (!repo?.current_snapshot_id) return { score: null, breakdown: {} };
  const snap = db().prepare(`SELECT loc FROM snapshots WHERE id = ?`).get(repo.current_snapshot_id) as any;
  const rows = db().prepare(`SELECT source, severity, COUNT(*) AS n FROM findings WHERE repository_id = ? AND review_id IS NULL AND status IN ('open','triaged','in_progress') AND origin = 'detected' GROUP BY source, severity`).all(repoId) as any[];
  const kloc = Math.max(1, (snap?.loc ?? 0) / 1000);
  const penalty: Record<string, number> = {};
  for (const r of rows) penalty[r.source] = (penalty[r.source] ?? 0) + SEV_WEIGHT[r.severity] * r.n;
  // Normalise per KLOC so larger codebases aren't penalised just for size; cap each dimension.
  const dim = (srcs: string[], cap: number) => Math.min(cap, srcs.reduce((a, s) => a + (penalty[s] ?? 0), 0) / kloc);
  const breakdown = {
    reliability: Math.round(100 - dim(["bug"], 100) ),
    security: Math.round(100 - dim(["security", "secret", "dependency"], 100)),
    performance: Math.round(100 - dim(["performance"], 100)),
    maintainability: Math.round(100 - dim(["debt"], 100)),
  };
  const score = Math.round(breakdown.reliability * 0.3 + breakdown.security * 0.35 + breakdown.performance * 0.1 + breakdown.maintainability * 0.25);
  return { score, breakdown };
}

export function architectureSummary(snapshotId: string, repoId: string) {
  const d = db();
  const files = d.prepare(`SELECT id, path, language, loc, complexity, is_test FROM files WHERE snapshot_id = ?`).all(snapshotId) as any[];
  const edges = d.prepare(`SELECT e.source_file_id AS s, e.target_file_id AS t FROM edges e WHERE e.snapshot_id = ? AND e.kind = 'import' AND e.target_file_id IS NOT NULL`).all(snapshotId) as any[];
  const byId = new Map(files.map((f) => [f.id, f]));
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.s === e.t) continue;
    fanIn.set(e.t, (fanIn.get(e.t) ?? 0) + 1);
    fanOut.set(e.s, (fanOut.get(e.s) ?? 0) + 1);
    const sp = byId.get(e.s)?.path;
    const tp = byId.get(e.t)?.path;
    if (sp && tp) (adj.get(sp) ?? adj.set(sp, []).get(sp)!).push(tp);
  }
  const findingCounts = new Map(
    (d.prepare(`SELECT file_path, COUNT(*) AS n FROM findings WHERE repository_id = ? AND review_id IS NULL AND status IN ('open','triaged','in_progress') GROUP BY file_path`).all(repoId) as any[]).map((r) => [r.file_path, r.n]),
  );
  const code = files.filter((f) => f.language && !["json", "yaml", "markdown", "text", "toml", "xml", "css", "scss", "html", "dotenv"].includes(f.language));
  const modules = new Map<string, { files: number; loc: number }>();
  for (const f of code) {
    const mod = f.path.includes("/") ? f.path.split("/").slice(0, Math.min(2, f.path.split("/").length - 1)).join("/") : "(root)";
    const m = modules.get(mod) ?? { files: 0, loc: 0 };
    m.files++;
    m.loc += f.loc;
    modules.set(mod, m);
  }
  const cycles = stronglyConnected([...adj.keys()], adj).slice(0, 30).map((c) => ({ size: c.length, path: cyclePath(c, adj) }));
  const hotspots = code
    .filter((f) => !f.is_test)
    .map((f) => ({ path: f.path, fanIn: fanIn.get(f.id) ?? 0, fanOut: fanOut.get(f.id) ?? 0, complexity: f.complexity, loc: f.loc, findings: findingCounts.get(f.path) ?? 0 }))
    .sort((a, b) => b.fanIn - a.fanIn)
    .slice(0, 15);
  const risk = code
    .filter((f) => !f.is_test)
    .map((f) => {
      const fi = fanIn.get(f.id) ?? 0;
      const fn = findingCounts.get(f.path) ?? 0;
      return { path: f.path, score: Math.round(Math.log2(2 + f.complexity) * (1 + fi) * (1 + fn)), complexity: f.complexity, fanIn: fi, findings: fn };
    })
    .filter((r) => r.complexity > 0 || r.findings > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
  const isolated = code
    .filter((f) => !f.is_test && ["typescript", "javascript", "python"].includes(f.language) && !fanIn.get(f.id) && !fanOut.get(f.id))
    .map((f) => f.path)
    .slice(0, 50);
  return {
    modules: [...modules.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.loc - a.loc),
    files: code.length,
    importEdges: edges.length,
    cycles,
    hotspots,
    highRisk: risk,
    isolated,
  };
}

export function dashboard(workspaceId: string, repoId?: string | null) {
  const d = db();
  const repos = d.prepare(`SELECT id, name, status, current_snapshot_id, last_analyzed_at, languages, frameworks FROM repositories WHERE workspace_id = ? ${repoId ? "AND id = ?" : ""} ORDER BY created_at`).all(workspaceId, ...(repoId ? [repoId] : [])) as any[];
  if (!repos.length) return { empty: true, repositories: [] };
  const ids = repos.map((r) => r.id);
  const inR = `(${ids.map(() => "?").join(",")})`;
  const open = d.prepare(`SELECT source, severity, COUNT(*) AS n FROM findings WHERE repository_id IN ${inR} AND review_id IS NULL AND status IN ('open','triaged','in_progress') GROUP BY source, severity`).all(...ids) as any[];
  const bySource: Record<string, Record<string, number>> = {};
  const bySeverity: Record<string, number> = {};
  for (const r of open) {
    (bySource[r.source] ??= {})[r.severity] = r.n;
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + r.n;
  }
  // trend: findings opened / resolved per day over the last 30 days
  const trend = d
    .prepare(
      `SELECT day, SUM(opened) AS opened, SUM(resolved) AS resolved FROM (
         SELECT substr(first_seen_at,1,10) AS day, COUNT(*) AS opened, 0 AS resolved FROM findings WHERE repository_id IN ${inR} AND review_id IS NULL AND first_seen_at >= date('now','-30 day') GROUP BY day
         UNION ALL
         SELECT substr(resolved_at,1,10) AS day, 0, COUNT(*) FROM findings WHERE repository_id IN ${inR} AND review_id IS NULL AND resolved_at >= date('now','-30 day') GROUP BY day
       ) GROUP BY day ORDER BY day`,
    )
    .all(...ids, ...ids);
  const scans = d.prepare(`SELECT s.id, s.kind, s.status, s.summary, s.started_at, s.finished_at, r.name AS repo FROM scans s JOIN repositories r ON r.id = s.repository_id WHERE s.repository_id IN ${inR} ORDER BY s.created_at DESC LIMIT 12`).all(...ids) as any[];
  const agentRuns = d.prepare(`SELECT agent_key, status, COUNT(*) AS n FROM agent_runs WHERE workspace_id = ? AND created_at >= date('now','-30 day') GROUP BY agent_key, status`).all(workspaceId);
  const tests = d.prepare(`SELECT status, passed, failed, created_at FROM test_runs WHERE repository_id IN ${inR} AND passed IS NOT NULL ORDER BY created_at DESC LIMIT 20`).all(...ids);
  const investigations = d.prepare(`SELECT id, title, status, created_at FROM investigations WHERE repository_id IN ${inR} ORDER BY created_at DESC LIMIT 5`).all(...ids);
  const top = d.prepare(`SELECT id, title, severity, source, file_path, line, repository_id FROM findings WHERE repository_id IN ${inR} AND review_id IS NULL AND status = 'open' AND severity IN ('critical','high') ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, first_seen_at DESC LIMIT 8`).all(...ids);
  return {
    empty: false,
    repositories: repos.map((r) => {
      const snap = r.current_snapshot_id ? (d.prepare(`SELECT stats, commit_sha FROM snapshots WHERE id = ?`).get(r.current_snapshot_id) as any) : null;
      const st = json<any>(snap?.stats, {});
      const deps = r.current_snapshot_id ? (d.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN vulns != '[]' THEN 1 ELSE 0 END) AS vulnerable, SUM(CASE WHEN latest_version IS NOT NULL AND latest_version != resolved_version THEN 1 ELSE 0 END) AS outdated FROM dependencies WHERE snapshot_id = ?`).get(r.current_snapshot_id) as any) : null;
      return {
        id: r.id, name: r.name, status: r.status, lastAnalyzedAt: r.last_analyzed_at, commit: snap?.commit_sha ?? null,
        languages: json(r.languages, {}), frameworks: json(r.frameworks, []),
        health: healthScore(r.id),
        size: st.loc != null ? { files: st.files, loc: st.loc, testFiles: st.testFiles, codeFiles: st.codeFiles } : null,
        testFileRatio: st.codeFiles ? Math.round((st.testFiles / st.codeFiles) * 100) : null,
        dependencies: deps?.n ? { total: deps.n, vulnerable: deps.vulnerable ?? 0, outdated: deps.outdated ?? 0 } : null,
      };
    }),
    findings: { bySource, bySeverity, total: Object.values(bySeverity).reduce((a, b) => a + b, 0) },
    trend,
    scans: scans.map((s) => ({ ...s, summary: json(s.summary, {}) })),
    agentRuns,
    tests,
    investigations,
    topFindings: top,
  };
}

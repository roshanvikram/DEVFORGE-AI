import fs from "node:fs";
import path from "node:path";
import { db, json } from "../db/db.js";
import { repoDir, analyzeSnapshot, PRESETS, type ScanKind } from "../services/analysis.js";
import { loadContext } from "../engine/indexer.js";
import { searchCode, searchSymbols } from "../services/search.js";
import { architectureSummary } from "../services/metrics.js";
import { newId } from "../lib/ids.js";
import { persistFindings } from "../services/findings.js";
import { enqueue } from "../jobs/queue.js";
import type { AITool } from "../ai/provider.js";

export interface ToolEnv {
  workspaceId: string;
  userId: string | null;
  repo: any;
  runId: string;
  agentKey: string;
  signal: AbortSignal;
  log: (m: string) => void;
}

export interface AgentTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  run: (input: any, env: ToolEnv) => Promise<unknown>;
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (d: string) => ({ type: "string", description: d });
const int = (d: string) => ({ type: "integer", description: d });

function safePath(root: string, rel: string) {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new Error("Path escapes repository root");
  return abs;
}

export const TOOLS: Record<string, AgentTool> = {
  repository_overview: {
    name: "repository_overview",
    description: "Languages, frameworks, size, symbol counts, routes and models of the repository's current snapshot.",
    schema: obj({}),
    run: async (_i, env) => {
      const s = db().prepare(`SELECT stats, commit_sha, branch FROM snapshots WHERE id = ?`).get(env.repo.current_snapshot_id) as any;
      const routes = db().prepare(`SELECT s.name, f.path, s.line FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.snapshot_id = ? AND s.kind = 'route' LIMIT 60`).all(env.repo.current_snapshot_id);
      const models = db().prepare(`SELECT s.name, f.path, s.line FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.snapshot_id = ? AND s.kind = 'model' LIMIT 60`).all(env.repo.current_snapshot_id);
      return { name: env.repo.name, frameworks: json(env.repo.frameworks, []), commit: s?.commit_sha, branch: s?.branch, stats: json(s?.stats, {}), routes, models };
    },
  },
  architecture_summary: {
    name: "architecture_summary",
    description: "Module structure, circular dependencies, most-depended-on files (hotspots), isolated files and high-risk components.",
    schema: obj({}),
    run: async (_i, env) => architectureSummary(env.repo.current_snapshot_id, env.repo.id),
  },
  search_code: {
    name: "search_code",
    description: "Full-text search over the repository (BM25). Returns files with matching lines and line numbers.",
    schema: obj({ query: str("Search terms"), limit: int("Max files (default 10)") }, ["query"]),
    run: async (i, env) => searchCode(env.repo.current_snapshot_id, String(i.query), { limit: Math.min(Number(i.limit) || 10, 25) }),
  },
  find_symbol: {
    name: "find_symbol",
    description: "Find functions/classes/routes/models by name.",
    schema: obj({ name: str("Symbol name or fragment") }, ["name"]),
    run: async (i, env) => searchSymbols(env.repo.current_snapshot_id, String(i.name), 20),
  },
  read_file: {
    name: "read_file",
    description: "Read a file (or a line range) from the repository. Lines are numbered.",
    schema: obj({ path: str("Repository-relative path"), start_line: int("First line (1-based)"), end_line: int("Last line") }, ["path"]),
    run: async (i, env) => {
      const root = repoDir(env.repo.id);
      const abs = safePath(root, String(i.path));
      if (!fs.existsSync(abs)) return { error: "File not found" };
      const lines = fs.readFileSync(abs, "utf8").split("\n");
      const s = Math.max(1, Number(i.start_line) || 1);
      const e = Math.min(lines.length, Number(i.end_line) || Math.min(lines.length, s + 199));
      return { path: i.path, totalLines: lines.length, content: lines.slice(s - 1, Math.min(e, s + 399)).map((l, k) => `${s + k}| ${l}`).join("\n") };
    },
  },
  list_files: {
    name: "list_files",
    description: "List indexed files under a directory prefix with language and LOC.",
    schema: obj({ prefix: str("Directory prefix, e.g. 'src/api' (empty for root)") }),
    run: async (i, env) => db().prepare(`SELECT path, language, loc, complexity, is_test FROM files WHERE snapshot_id = ? AND path LIKE ? ORDER BY path LIMIT 200`).all(env.repo.current_snapshot_id, `${String(i.prefix ?? "").replace(/[%_]/g, "")}%`),
  },
  get_callers: {
    name: "get_callers",
    description: "Who calls a function (resolved call graph edges).",
    schema: obj({ symbol: str("Function name"), file: str("File that defines it (optional)") }, ["symbol"]),
    run: async (i, env) => db().prepare(`SELECT sf.path AS caller_file, e.source_symbol AS caller, e.line, tf.path AS target_file FROM edges e JOIN files sf ON sf.id = e.source_file_id JOIN files tf ON tf.id = e.target_file_id WHERE e.snapshot_id = ? AND e.kind = 'call' AND e.target_symbol = ? ${i.file ? "AND tf.path = ?" : ""} LIMIT 50`).all(env.repo.current_snapshot_id, i.symbol, ...(i.file ? [i.file] : [])),
  },
  get_dependencies: {
    name: "get_dependencies",
    description: "Imports of a file and the files that import it.",
    schema: obj({ path: str("Repository-relative path") }, ["path"]),
    run: async (i, env) => ({
      imports: db().prepare(`SELECT COALESCE(tf.path, e.target_external) AS target, e.target_symbol AS names FROM edges e JOIN files sf ON sf.id = e.source_file_id LEFT JOIN files tf ON tf.id = e.target_file_id WHERE e.snapshot_id = ? AND e.kind = 'import' AND sf.path = ?`).all(env.repo.current_snapshot_id, i.path),
      importedBy: db().prepare(`SELECT DISTINCT sf.path FROM edges e JOIN files sf ON sf.id = e.source_file_id JOIN files tf ON tf.id = e.target_file_id WHERE e.snapshot_id = ? AND e.kind = 'import' AND tf.path = ?`).all(env.repo.current_snapshot_id, i.path),
    }),
  },
  list_findings: {
    name: "list_findings",
    description: "List open findings from previous scans. Filter by source (bug|security|secret|dependency|performance|debt), severity, or file.",
    schema: obj({ source: str("Finding source"), severity: str("critical|high|medium|low|info"), file: str("File path"), limit: int("Max results (default 30)") }),
    run: async (i, env) => {
      const where = ["repository_id = ?", "review_id IS NULL", "status IN ('open','triaged','in_progress')"];
      const args: any[] = [env.repo.id];
      if (i.source) { where.push("source = ?"); args.push(i.source); }
      if (i.severity) { where.push("severity = ?"); args.push(i.severity); }
      if (i.file) { where.push("file_path = ?"); args.push(i.file); }
      return db().prepare(`SELECT id, source, origin, title, severity, confidence, category, file_path, line, evidence FROM findings WHERE ${where.join(" AND ")} ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END LIMIT ?`).all(...args, Math.min(Number(i.limit) || 30, 100));
    },
  },
  run_scan: {
    name: "run_scan",
    description: "Run static analyzers on the current snapshot. kinds: any of bug, security, dependency, performance, debt. Returns per-scan finding counts and tool statuses.",
    schema: obj({ kinds: { type: "array", items: { type: "string", enum: ["bug", "security", "dependency", "performance", "debt"] } } }, ["kinds"]),
    run: async (i, env) => {
      const kinds = (i.kinds as string[]).filter((k) => (PRESETS.full as string[]).includes(k)) as ScanKind[];
      const ctx = loadContext(env.repo.current_snapshot_id, repoDir(env.repo.id));
      const r = await analyzeSnapshot(env.repo, ctx, kinds, { id: `agent:${env.runId}`, userId: env.userId, signal: env.signal, log: env.log, progress: () => {} });
      return r.scans.map((s: any) => ({ kind: s.kind, findings: s.findings, created: s.created, autoResolved: s.autoResolved, bySeverity: s.bySeverity, error: s.error, tools: Object.fromEntries(Object.entries(s.tools ?? {}).map(([k, v]: any) => [k, v.status])) }));
    },
  },
  dependency_report: {
    name: "dependency_report",
    description: "Declared dependencies with versions, latest versions, licenses and known vulnerabilities (from the last dependency scan).",
    schema: obj({}),
    run: async (_i, env) => (db().prepare(`SELECT ecosystem, name, version_spec, resolved_version, latest_version, license, dev, vulns, manifest_path FROM dependencies WHERE snapshot_id = ? ORDER BY name LIMIT 400`).all(env.repo.current_snapshot_id) as any[]).map((d) => ({ ...d, vulns: json(d.vulns, []).map((v: any) => `${v.id} (${v.severity})`) })),
  },
  record_hypothesis: {
    name: "record_hypothesis",
    description: "Record an AI-generated hypothesis as a finding (clearly labelled as an AI hypothesis, not a detected issue). Use only with concrete evidence.",
    schema: obj({ title: str("Short title"), category: str("Category"), severity: str("critical|high|medium|low|info"), file: str("File path"), line: int("Line"), evidence: str("Concrete evidence (quote code)"), explanation: str("Why this is a problem"), recommendation: str("Suggested fix") }, ["title", "category", "severity", "evidence", "explanation", "recommendation"]),
    run: async (i, env) => {
      const sev = ["critical", "high", "medium", "low", "info"].includes(i.severity) ? i.severity : "low";
      const r = persistFindings({ workspaceId: env.workspaceId, repositoryId: env.repo.id, findings: [{ source: env.agentKey === "security_auditor" ? "security" : env.agentKey === "performance_engineer" ? "performance" : "bug", origin: "ai_hypothesis", tool: `agent:${env.agentKey}`, rule_id: `agent/${env.agentKey}`, title: String(i.title).slice(0, 200), category: String(i.category), severity: sev, confidence: "low", file_path: i.file ?? null, line: i.line ?? null, evidence: String(i.evidence), explanation: String(i.explanation), impact: "To be confirmed", recommendation: String(i.recommendation), verification: "AI hypothesis — verify manually or with a targeted test." }] });
      return { recorded: r.created > 0, note: "Stored as an AI hypothesis" };
    },
  },
  save_document: {
    name: "save_document",
    description: "Save a Markdown document to the workspace Knowledge Base (e.g. generated architecture docs).",
    schema: obj({ title: str("Document title"), content: str("Markdown content") }, ["title", "content"]),
    run: async (i, env) => {
      const id = newId("kb_");
      db().prepare(`INSERT INTO knowledge_docs (id, workspace_id, repository_id, title, kind, content, created_by) VALUES (?,?,?,?, 'generated', ?, ?)`).run(id, env.workspaceId, env.repo.id, String(i.title).slice(0, 200), String(i.content).slice(0, 500_000), env.userId);
      db().prepare(`INSERT INTO kb_fts (title, content, doc_id, workspace_id) VALUES (?,?,?,?)`).run(i.title, i.content, id, env.workspaceId);
      return { id };
    },
  },
  generate_tests: {
    name: "generate_tests",
    description: "Queue Test Forge to generate and execute tests (in the sandbox) for a file/function. Returns the test run id.",
    schema: obj({ path: str("File path"), symbol: str("Function name (optional)") }, ["path"]),
    run: async (i, env) => {
      const id = newId("tst_");
      db().prepare(`INSERT INTO test_runs (id, workspace_id, repository_id, kind, target, status, created_by) VALUES (?,?,?, 'generate', ?, 'queued', ?)`).run(id, env.workspaceId, env.repo.id, JSON.stringify({ path: i.path, symbol: i.symbol ?? null }), env.userId);
      const job = enqueue("tests.generate", env.workspaceId, { runId: id }, { userId: env.userId });
      db().prepare(`UPDATE test_runs SET job_id = ? WHERE id = ?`).run(job, id);
      return { testRunId: id, status: "queued" };
    },
  },
  handoff: {
    name: "handoff",
    description: "Hand off a sub-task to another specialist agent. It runs after this agent finishes.",
    schema: obj({ agent: str("Agent key"), task: str("Precise task description") }, ["agent", "task"]),
    run: async () => ({ error: "handoff is handled by the runner" }),
  },
};

export function toolDefs(names: string[]): AITool[] {
  return names.filter((n) => TOOLS[n]).map((n) => ({ name: n, description: TOOLS[n].description, input_schema: TOOLS[n].schema as any }));
}

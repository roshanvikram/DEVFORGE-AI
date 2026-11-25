import fs from "node:fs";
import path from "node:path";
import { db, now, json } from "../db/db.js";
import { registerHandler, type JobCtx } from "../jobs/queue.js";
import { getRepo, repoDir } from "./analysis.js";
import { prepareWorkdir, sandboxExec, cleanupWorkdir, sandboxMode } from "../sandbox/runner.js";
import { providerFor, parseJson } from "../ai/provider.js";
import { retrieveContext, formatContext } from "./search.js";
import { publish } from "../lib/events.js";
import { audit, notify } from "../lib/audit.js";

export type Framework = "vitest" | "jest" | "mocha" | "playwright" | "pytest" | "npm-test" | "unknown";

export function detectFramework(root: string, forFile?: string): { framework: Framework; language: "js" | "python" | "unknown"; reason: string } {
  const isPy = forFile ? forFile.endsWith(".py") : fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "requirements.txt")) || fs.existsSync(path.join(root, "setup.py"));
  if (isPy && (!forFile || forFile.endsWith(".py"))) return { framework: "pytest", language: "python", reason: "Python project (pytest)" };
  // nearest package.json walking up from the file
  let dir = forFile ? path.dirname(path.join(root, forFile)) : root;
  while (dir.startsWith(root)) {
    const pj = path.join(dir, "package.json");
    if (fs.existsSync(pj)) {
      try {
        const j = JSON.parse(fs.readFileSync(pj, "utf8"));
        const all = { ...j.dependencies, ...j.devDependencies };
        if (all.vitest) return { framework: "vitest", language: "js", reason: `vitest in ${path.relative(root, pj) || "package.json"}` };
        if (all.jest || all["ts-jest"]) return { framework: "jest", language: "js", reason: `jest in ${path.relative(root, pj) || "package.json"}` };
        if (all.mocha) return { framework: "mocha", language: "js", reason: "mocha" };
        if (all["@playwright/test"]) return { framework: "playwright", language: "js", reason: "playwright" };
        if (j.scripts?.test && !/no test specified/.test(j.scripts.test)) return { framework: "npm-test", language: "js", reason: "package.json test script" };
      } catch { /* ignore */ }
      break;
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return { framework: forFile && /\.(t|j)sx?$/.test(forFile) ? "vitest" : "unknown", language: forFile && /\.(t|j)sx?$/.test(forFile) ? "js" : "unknown", reason: "No test framework declared" };
}

/** Deterministic branch/edge-case extraction from a function's source. */
export function analyzeFunction(src: string, lang: "js" | "python" | "unknown") {
  const lines = src.split("\n");
  const branches: { line: number; condition: string }[] = [];
  const throws: { line: number; text: string }[] = [];
  const comparisons: string[] = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    const cond = t.match(/^(?:\}?\s*else\s+)?if\s*\((.*)\)\s*\{?$/) ?? t.match(/^(?:el)?if\s+(.*):$/) ?? t.match(/^case\s+(.*):/) ?? t.match(/^while\s*\(?(.*?)\)?\s*[:{]?$/);
    if (cond) branches.push({ line: i + 1, condition: cond[1].slice(0, 160) });
    if (/\b(throw|raise)\b/.test(t)) throws.push({ line: i + 1, text: t.slice(0, 160) });
    for (const m of t.matchAll(/(\w[\w.]*)\s*(<=|>=|<|>|===|==|!==|!=)\s*(-?\d+(?:\.\d+)?)/g)) comparisons.push(`${m[1]} ${m[2]} ${m[3]}`);
  });
  const sig = lines[0] ?? "";
  const params = (sig.match(/\(([^)]*)\)/)?.[1] ?? "").split(",").map((p) => p.trim().split(/[:=\s]/)[0].replace(/[{}[\]?.]/g, "")).filter((p) => p && p !== "self" && p !== "cls");
  const edgeCases = new Set<string>();
  for (const p of params) {
    edgeCases.add(`${p} is ${lang === "python" ? "None" : "null/undefined"}`);
    edgeCases.add(`${p} is empty (empty string / empty collection)`);
  }
  for (const c of comparisons) {
    const [v, op, n] = c.split(" ");
    const num = Number(n);
    edgeCases.add(`${v} exactly at boundary ${num} (${op})`);
    edgeCases.add(`${v} just ${op.includes("<") ? "above" : "below"} boundary (${op.includes("<") ? num + 1 : num - 1})`);
  }
  for (const t of throws) edgeCases.add(`error path: ${t.text}`);
  const scenarios = [
    { title: "Happy path with typical valid input", kind: "unit", rationale: "Baseline behaviour" },
    ...branches.slice(0, 12).map((b) => ({ title: `Branch at line ${b.line}: ${b.condition}`, kind: "branch", rationale: "Cover both outcomes of the condition" })),
    ...throws.slice(0, 6).map((t) => ({ title: `Error raised at line ${t.line}`, kind: "error", rationale: t.text })),
  ];
  return { params, branches, throws, edgeCases: [...edgeCases].slice(0, 20), scenarios, branchCount: branches.length };
}

function commandFor(fw: Framework, files: string[], reportPath: string): string[] {
  switch (fw) {
    case "vitest": return ["npx", "--no-install", "vitest", "run", "--reporter=json", `--outputFile=${reportPath}`, ...files];
    case "jest": return ["npx", "--no-install", "jest", "--json", `--outputFile=${reportPath}`, "--ci", ...files];
    case "mocha": return ["npx", "--no-install", "mocha", "--reporter", "json", ...files];
    case "playwright": return ["npx", "--no-install", "playwright", "test", "--reporter=json", ...files];
    case "pytest": return ["python3", "-m", "pytest", "-q", "-p", "no:cacheprovider", `--junitxml=${reportPath}`, ...files];
    case "npm-test": return ["npm", "test", "--silent"];
    default: return [];
  }
}

function parseResults(fw: Framework, reportFile: string, stdout: string, stderr: string) {
  const res = { passed: 0, failed: 0, skipped: 0, failures: [] as { name: string; message: string }[], parsed: false };
  try {
    if (fs.existsSync(reportFile)) {
      const raw = fs.readFileSync(reportFile, "utf8");
      if (fw === "pytest") {
        const total = Number(raw.match(/tests="(\d+)"/)?.[1] ?? 0);
        const failures = Number(raw.match(/failures="(\d+)"/)?.[1] ?? 0);
        const errors = Number(raw.match(/errors="(\d+)"/)?.[1] ?? 0);
        const skipped = Number(raw.match(/skipped="(\d+)"/)?.[1] ?? 0);
        res.failed = failures + errors;
        res.skipped = skipped;
        res.passed = Math.max(0, total - res.failed - skipped);
        for (const m of raw.matchAll(/<testcase[^>]*name="([^"]+)"[^>]*>\s*<(failure|error)[^>]*message="([^"]*)"/g)) res.failures.push({ name: m[1], message: m[3].slice(0, 500) });
        res.parsed = true;
      } else {
        const j = JSON.parse(raw);
        res.passed = j.numPassedTests ?? 0;
        res.failed = (j.numFailedTests ?? 0) + (j.numRuntimeErrorTestSuites ?? 0);
        res.skipped = (j.numPendingTests ?? 0) + (j.numTodoTests ?? 0);
        for (const s of j.testResults ?? []) {
          for (const a of s.assertionResults ?? []) if (a.status === "failed") res.failures.push({ name: a.fullName ?? a.title, message: (a.failureMessages ?? []).join("\n").slice(0, 800) });
          if (s.status === "failed" && !(s.assertionResults ?? []).length) res.failures.push({ name: s.name, message: String(s.message ?? "").slice(0, 800) });
        }
        res.parsed = true;
      }
    } else if (fw === "mocha") {
      const j = JSON.parse(stdout.slice(stdout.indexOf("{")));
      res.passed = j.stats?.passes ?? 0;
      res.failed = j.stats?.failures ?? 0;
      res.skipped = j.stats?.pending ?? 0;
      for (const f of j.failures ?? []) res.failures.push({ name: f.fullTitle, message: f.err?.message ?? "" });
      res.parsed = true;
    }
  } catch { /* fall through to text parsing */ }
  if (!res.parsed) {
    const text = stdout + "\n" + stderr;
    // TAP summary (node --test, tap, ava): "# pass 3" / "# fail 1" / "# skipped 0"
    const tp = text.match(/^# pass (\d+)/m);
    const tf = text.match(/^# fail (\d+)/m);
    if (tp || tf) {
      res.passed = Number(tp?.[1] ?? 0);
      res.failed = Number(tf?.[1] ?? 0);
      res.skipped = Number(text.match(/^# skip(?:ped)? (\d+)/m)?.[1] ?? 0) + Number(text.match(/^# todo (\d+)/m)?.[1] ?? 0);
      for (const m of text.matchAll(/^not ok \d+ - (.+)$/gm)) res.failures.push({ name: m[1].trim(), message: "" });
      res.parsed = true;
      return res;
    }
    const p = text.match(/(\d+)\s+(passed|passing)/i);
    const f = text.match(/(\d+)\s+(failed|failing)/i);
    const s = text.match(/(\d+)\s+(skipped|pending)/i);
    if (p || f) {
      res.passed = Number(p?.[1] ?? 0);
      res.failed = Number(f?.[1] ?? 0);
      res.skipped = Number(s?.[1] ?? 0);
      res.parsed = true;
    }
  }
  return res;
}

const GEN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scenarios", "files", "notes"],
  properties: {
    scenarios: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "kind", "rationale"], properties: { title: { type: "string" }, kind: { type: "string" }, rationale: { type: "string" } } } },
    files: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } },
    notes: { type: "string" },
  },
};

async function runInSandbox(ctx: JobCtx, runId: string, root: string, fw: Framework, files: { path: string; content: string }[], install: boolean) {
  const work = prepareWorkdir(root);
  try {
    const src = path.join(work, "src");
    for (const f of files) {
      const abs = path.resolve(src, f.path);
      if (!abs.startsWith(src + path.sep)) throw new Error(`Refusing to write outside the workdir: ${f.path}`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content);
    }
    const lang = fw === "pytest" ? "python" : "js";
    if (install) {
      ctx.log("Installing dependencies inside the sandbox (network enabled for this step only, lifecycle scripts disabled)");
      const installCmd = lang === "js"
        ? (fs.existsSync(path.join(src, "package-lock.json")) ? ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"] : ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"])
        : ["python3", "-m", "pip", "install", "--quiet", "--target", path.join(work, ".pydeps"), "pytest", ...(fs.existsSync(path.join(src, "requirements.txt")) ? ["-r", "requirements.txt"] : [])];
      const r = await sandboxExec(work, installCmd, { allowNetwork: true, timeoutMs: 600_000, signal: ctx.signal });
      ctx.log(`Install exited with ${r.exitCode}${r.timedOut ? " (timed out)" : ""}`);
      if (r.exitCode !== 0) ctx.log(r.stderr.split("\n").slice(-5).join("\n"), "warn");
    } else if (lang === "js" && !fs.existsSync(path.join(src, "node_modules"))) {
      ctx.log("Dependencies are not installed in the repository copy; enable 'Install dependencies' if tests cannot start.", "warn");
    }
    const report = path.join(work, ".tmp", "report." + (fw === "pytest" ? "xml" : "json"));
    const cmd = commandFor(fw, files.map((f) => f.path), report);
    if (!cmd.length) throw new Error("No supported test framework detected for this target");
    db().prepare(`UPDATE test_runs SET status = 'running', command = ? WHERE id = ?`).run(cmd.join(" "), runId);
    publish(ctx.workspaceId, { type: "test_run", id: runId, status: "running" });
    ctx.log(`$ ${cmd.join(" ")}`);
    const r = await sandboxExec(work, cmd, { timeoutMs: config_timeout(), env: lang === "python" ? { PYTHONPATH: [path.join(work, ".pydeps"), src].join(":") } : {}, signal: ctx.signal });
    const parsed = parseResults(fw, report, r.stdout, r.stderr);
    return { ...r, ...parsed };
  } finally {
    cleanupWorkdir(work);
  }
}
const config_timeout = () => Number(process.env.SANDBOX_TIMEOUT_SEC ?? 180) * 1000;

async function finalize(ctx: JobCtx, runId: string, repo: any, r: Awaited<ReturnType<typeof runInSandbox>>, aiAnalysis: (failures: any[]) => Promise<string | null>) {
  let status = r.timedOut ? "timed_out" : r.exitCode === 0 && r.failed === 0 ? "passed" : r.parsed && r.failed > 0 ? "failed" : "error";
  if (status === "passed" && !r.parsed) status = "completed";
  let analysis: string | null = null;
  if (r.failures.length || status === "error") {
    analysis = `Failures (${r.failures.length}):\n` + r.failures.slice(0, 10).map((f) => `• ${f.name}\n  ${f.message.split("\n")[0]}`).join("\n");
    if (status === "error" && !r.failures.length) analysis = `The test command did not complete normally (exit ${r.exitCode}). Last output:\n${(r.stderr || r.stdout).split("\n").slice(-15).join("\n")}`;
    try {
      const ai = await aiAnalysis(r.failures);
      if (ai) analysis += `\n\nAI failure analysis (hypothesis):\n${ai}`;
    } catch (e: any) {
      ctx.log(`AI failure analysis unavailable: ${e.message}`, "warn");
    }
  }
  db().prepare(`UPDATE test_runs SET status = ?, sandbox = ?, stdout = ?, stderr = ?, exit_code = ?, passed = ?, failed = ?, skipped = ?, duration_ms = ?, analysis = ?, finished_at = ? WHERE id = ?`)
    .run(status, r.mode, r.stdout.slice(-200_000), r.stderr.slice(-100_000), r.exitCode, r.parsed ? r.passed : null, r.parsed ? r.failed : null, r.parsed ? r.skipped : null, r.durationMs, analysis, now(), runId);
  publish(ctx.workspaceId, { type: "test_run", id: runId, status });
  audit({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: "tests.executed", entityType: "test_run", entityId: runId, data: { status, passed: r.passed, failed: r.failed } });
  notify({ workspaceId: ctx.workspaceId, userId: ctx.userId ?? undefined, kind: "tests", title: `Tests ${status}: ${repo.name}`, body: r.parsed ? `${r.passed} passed, ${r.failed} failed` : `exit code ${r.exitCode}`, link: `/app/tests?run=${runId}` });
  return { status, passed: r.passed, failed: r.failed };
}

async function generateJob(ctx: JobCtx) {
  const { runId } = ctx.payload as { runId: string };
  const run = db().prepare(`SELECT * FROM test_runs WHERE id = ?`).get(runId) as any;
  const repo = getRepo(ctx.workspaceId, run.repository_id);
  const target = json<any>(run.target, {});
  const root = repoDir(repo.id);
  const abs = path.resolve(root, target.path);
  if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) throw new Error("Target file not found in repository");
  const content = fs.readFileSync(abs, "utf8");
  const lines = content.split("\n");
  // 1-2. Select & analyse code
  let sym: any = null;
  if (target.symbol) sym = db().prepare(`SELECT s.* FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.snapshot_id = ? AND f.path = ? AND s.name = ? LIMIT 1`).get(repo.current_snapshot_id, target.path, target.symbol);
  const fnSrc = sym ? lines.slice(sym.line - 1, sym.end_line).join("\n") : content.slice(0, 20000);
  const fw = detectFramework(root, target.path);
  ctx.log(`Framework: ${fw.framework} (${fw.reason})`);
  ctx.progress(0.15, "Analysing branches and edge cases");
  // 3-5. Branches, edge cases, scenarios (deterministic)
  const analysis = analyzeFunction(fnSrc, fw.language);
  db().prepare(`UPDATE test_runs SET framework = ?, scenarios = ?, status = 'generating' WHERE id = ?`).run(fw.framework, JSON.stringify({ ...analysis, source: "static" }), runId);
  publish(ctx.workspaceId, { type: "test_run", id: runId, status: "generating" });

  // 6. Generate test files (requires AI)
  const ai = providerFor(ctx.workspaceId, ctx.userId);
  if (!ai) {
    db().prepare(`UPDATE test_runs SET status = 'scenarios_only', error = ?, finished_at = ? WHERE id = ? `).run("Test scenarios were derived statically. Generating runnable test code requires an AI provider (Settings → AI Providers).", now(), runId);
    publish(ctx.workspaceId, { type: "test_run", id: runId, status: "scenarios_only" });
    return { status: "scenarios_only" };
  }
  ctx.progress(0.3, "Generating test code with Claude");
  const related = retrieveContext(repo.current_snapshot_id, root, `${target.symbol ?? ""} ${path.basename(target.path)}`, { budgetChars: 24_000, mustInclude: [{ path: target.path, line: sym?.line }] });
  const testPath = fw.language === "python"
    ? path.posix.join(path.posix.dirname(target.path), `test_devforge_${path.posix.basename(target.path, ".py")}.py`)
    : path.posix.join(path.posix.dirname(target.path), `${path.posix.basename(target.path).replace(/\.(t|j)sx?$/, "")}.devforge.test${target.path.endsWith(".ts") || target.path.endsWith(".tsx") ? ".ts" : ".js"}`);
  const resp = await ai.complete({
    feature: "test_generation",
    signal: ctx.signal,
    jsonSchema: GEN_SCHEMA,
    system: `You are DevForge's Test Engineer. Write focused, runnable ${fw.framework} tests for the selected code. Only import modules that exist in the provided context, using correct relative paths from the test file location. Do not use network or real external services; mock them. Prefer behaviour assertions over implementation details. Return exactly one test file at the requested path.`,
    messages: [{
      role: "user",
      content: `Repository: ${repo.name}\nTarget file: ${target.path}${target.symbol ? `\nTarget symbol: ${target.symbol} (lines ${sym?.line}-${sym?.end_line})` : ""}\nTest framework: ${fw.framework}\nWrite the test file to: ${testPath}\n\nStatic analysis found these branches:\n${analysis.branches.map((b) => `- line ${b.line}: ${b.condition}`).join("\n") || "- (none)"}\nEdge cases to consider:\n${analysis.edgeCases.map((e) => `- ${e}`).join("\n")}\n\n${target.instructions ? `Additional instructions: ${target.instructions}\n\n` : ""}Code context:\n${formatContext(related)}`,
    }],
  });
  const gen = parseJson<{ scenarios: any[]; files: { path: string; content: string }[]; notes: string }>(resp.text);
  const files = gen.files.slice(0, 1).map((f) => ({ path: testPath, content: f.content }));
  db().prepare(`UPDATE test_runs SET scenarios = ?, generated_files = ?, ai_used = 1 WHERE id = ?`).run(JSON.stringify({ ...analysis, aiScenarios: gen.scenarios, notes: gen.notes, source: "static+ai" }), JSON.stringify(files), runId);

  // 7-10. Execute in sandbox, parse, analyse failures
  const mode = await sandboxMode();
  if (mode.mode === "disabled") {
    db().prepare(`UPDATE test_runs SET status = 'not_executed', error = ?, finished_at = ? WHERE id = ?`).run(`Generated tests were not executed: ${mode.reason}. Tests are never reported as passing unless executed.`, now(), runId);
    publish(ctx.workspaceId, { type: "test_run", id: runId, status: "not_executed" });
    return { status: "not_executed" };
  }
  ctx.progress(0.6, "Executing tests in sandbox");
  const r = await runInSandbox(ctx, runId, root, fw.framework, files, !!target.installDependencies);
  return finalize(ctx, runId, repo, r, async (failures) => {
    if (!failures.length) return null;
    const a = await ai.complete({
      feature: "test_failure_analysis",
      signal: ctx.signal,
      maxTokens: 4000,
      system: "You analyse failing generated tests. For each failure decide whether the TEST is wrong (bad import, wrong expectation) or the CODE likely has a bug, citing the code. Be concise; label conclusions as hypotheses.",
      messages: [{ role: "user", content: `Test file:\n${files[0].content.slice(0, 12000)}\n\nFailures:\n${failures.map((f: any) => `${f.name}: ${f.message}`).join("\n").slice(0, 8000)}\n\nCode under test:\n${fnSrc.slice(0, 12000)}` }],
    });
    return a.text;
  });
}

async function suiteJob(ctx: JobCtx) {
  const { runId } = ctx.payload as { runId: string };
  const run = db().prepare(`SELECT * FROM test_runs WHERE id = ?`).get(runId) as any;
  const repo = getRepo(ctx.workspaceId, run.repository_id);
  const target = json<any>(run.target, {});
  const root = repoDir(repo.id);
  const fw = detectFramework(root);
  db().prepare(`UPDATE test_runs SET framework = ? WHERE id = ?`).run(fw.framework, runId);
  const mode = await sandboxMode();
  if (mode.mode === "disabled") throw new Error(`Sandbox unavailable: ${mode.reason}`);
  const r = await runInSandbox(ctx, runId, root, fw.framework === "unknown" ? "npm-test" : fw.framework, [], !!target.installDependencies);
  return finalize(ctx, runId, repo, r, async () => null);
}

async function wrap(fn: (ctx: JobCtx) => Promise<any>, ctx: JobCtx) {
  try {
    return await fn(ctx);
  } catch (e: any) {
    db().prepare(`UPDATE test_runs SET status = ?, error = ?, finished_at = ? WHERE id = ? AND status NOT IN ('passed','failed','completed')`).run(ctx.signal.aborted ? "cancelled" : "error", String(e.message).slice(0, 1000), now(), ctx.payload.runId);
    publish(ctx.workspaceId, { type: "test_run", id: ctx.payload.runId, status: "error" });
    throw e;
  }
}

registerHandler("tests.generate", (ctx) => wrap(generateJob, ctx));
registerHandler("tests.suite", (ctx) => wrap(suiteJob, ctx));

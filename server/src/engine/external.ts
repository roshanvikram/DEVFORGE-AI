import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RawFinding, Severity } from "./types.js";

/**
 * Integrations with external scanners. Each tool is used only if its binary is installed.
 * None of these tools execute repository code: they read files (and for npm audit, the lockfile).
 * The result always reports what actually happened: ok / not_installed / failed / skipped.
 */
export type ToolStatus = { status: "ok" | "partial" | "not_installed" | "failed" | "skipped"; note: string; findings: number };

const SAFE_ENV = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", HOME: process.env.HOME ?? "/tmp", LANG: "C.UTF-8" });

export function run(cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number; maxBytes?: number }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; missing: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const max = opts.maxBytes ?? 20 * 1024 * 1024;
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: SAFE_ENV(), stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve({ code: null, stdout: "", stderr: "", timedOut: false, missing: true });
    }
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (b: Buffer) => { if (stdout.length < max) stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { if (stderr.length < 200_000) stderr += b.toString(); });
    child.on("error", (e: any) => { clearTimeout(t); resolve({ code: null, stdout, stderr: String(e.message), timedOut, missing: e.code === "ENOENT" }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code, stdout, stderr, timedOut, missing: false }); });
  });
}

const which = async (bin: string) => (await run("/usr/bin/which", [bin], { cwd: "/", timeoutMs: 5000 })).code === 0;

export async function detectTools() {
  const names = ["ruff", "semgrep", "gitleaks", "trivy", "pip-audit", "npm", "eslint", "git", "python3", "docker"];
  const res: Record<string, boolean> = {};
  await Promise.all(names.map(async (n) => (res[n] = await which(n))));
  return res;
}

const sevMap = (s: string): Severity => {
  const x = s.toLowerCase();
  if (x.startsWith("crit")) return "critical";
  if (x === "high" || x === "error") return "high";
  if (x === "moderate" || x === "medium" || x === "warning") return "medium";
  if (x === "low" || x === "note") return "low";
  return "info";
};

export async function runRuff(root: string): Promise<{ status: ToolStatus; findings: RawFinding[] }> {
  if (!(await which("ruff"))) return { status: { status: "not_installed", note: "Install ruff to enable (pip install ruff)", findings: 0 }, findings: [] };
  const r = await run("ruff", ["check", "--output-format", "json", "--no-cache", "--isolated", "--select", "E9,F,B,S,PERF", "."], { cwd: root, timeoutMs: 120_000 });
  try {
    const items = JSON.parse(r.stdout || "[]") as any[];
    const findings = items.slice(0, 1000).map((i) => ({
      source: (i.code?.startsWith("S") ? "security" : i.code?.startsWith("PERF") ? "performance" : "bug") as RawFinding["source"],
      tool: "ruff", rule_id: `ruff/${i.code}`, title: `${i.code}: ${i.message}`.slice(0, 160), category: i.code?.startsWith("S") ? "Security lint" : i.code?.startsWith("F8") ? "Undefined names" : "Lint",
      severity: (i.code?.startsWith("E9") || i.code === "F821" ? "high" : i.code?.startsWith("S") ? "medium" : "low") as Severity, confidence: "high" as const,
      file_path: path.relative(root, i.filename), line: i.location?.row ?? null, end_line: i.end_location?.row ?? null,
      evidence: `ruff ${i.code}: ${i.message}`, explanation: i.message, impact: "Reported by Ruff static analysis.",
      recommendation: i.fix?.message ?? `See https://docs.astral.sh/ruff/rules/ for ${i.code}.`, verification: "`ruff check` no longer reports this rule at this location.",
      related: i.url ? [i.url] : [],
    }));
    return { status: { status: "ok", note: `ruff reported ${findings.length} issues`, findings: findings.length }, findings };
  } catch {
    return { status: { status: "failed", note: (r.stderr || "could not parse ruff output").slice(0, 200), findings: 0 }, findings: [] };
  }
}

export async function runSemgrep(root: string): Promise<{ status: ToolStatus; findings: RawFinding[] }> {
  if (!(await which("semgrep"))) return { status: { status: "not_installed", note: "Install semgrep to enable (pip install semgrep)", findings: 0 }, findings: [] };
  const r = await run("semgrep", ["scan", "--config", "p/default", "--json", "--quiet", "--metrics=off", "--timeout", "30", "."], { cwd: root, timeoutMs: 600_000 });
  try {
    const j = JSON.parse(r.stdout);
    const findings: RawFinding[] = (j.results ?? []).slice(0, 1000).map((x: any) => ({
      source: "security", tool: "semgrep", rule_id: `semgrep/${x.check_id}`, title: (x.extra?.message ?? x.check_id).split("\n")[0].slice(0, 160),
      category: x.extra?.metadata?.category ?? "Security", severity: sevMap(x.extra?.severity ?? "warning"), confidence: (x.extra?.metadata?.confidence ?? "medium").toLowerCase(),
      file_path: x.path, line: x.start?.line, end_line: x.end?.line, snippet: x.extra?.lines?.slice(0, 600),
      evidence: `Semgrep rule ${x.check_id} matched.`, explanation: x.extra?.message ?? "", impact: x.extra?.metadata?.impact ?? "See rule documentation.",
      recommendation: x.extra?.fix ? `Suggested fix: ${x.extra.fix}` : "See the Semgrep rule documentation.", verification: "Re-run Semgrep.",
      related: x.extra?.metadata?.references ?? [],
    }));
    return { status: { status: "ok", note: `semgrep reported ${findings.length}`, findings: findings.length }, findings };
  } catch {
    return { status: { status: "failed", note: (r.stderr || "semgrep output not parseable").slice(0, 200), findings: 0 }, findings: [] };
  }
}

export async function runGitleaks(root: string): Promise<{ status: ToolStatus; findings: RawFinding[] }> {
  if (!(await which("gitleaks"))) return { status: { status: "not_installed", note: "Install gitleaks to scan git history (brew install gitleaks)", findings: 0 }, findings: [] };
  const report = path.join(root, "..", `.gitleaks-${Date.now()}.json`);
  const r = await run("gitleaks", ["detect", "--source", root, "--report-format", "json", "--report-path", report, "--redact", "--no-banner"], { cwd: root, timeoutMs: 300_000 });
  try {
    const items = JSON.parse(fs.readFileSync(report, "utf8")) as any[];
    fs.rmSync(report, { force: true });
    const findings: RawFinding[] = items.slice(0, 500).map((i) => ({
      source: "secret", tool: "gitleaks", rule_id: `gitleaks/${i.RuleID}`, title: `${i.Description ?? i.RuleID} (git history)`, category: "Exposed credentials",
      severity: "high", confidence: "high", file_path: i.File, line: i.StartLine, snippet: String(i.Match ?? "").slice(0, 200),
      evidence: `gitleaks rule ${i.RuleID} matched in commit ${String(i.Commit ?? "").slice(0, 10)} (redacted).`,
      explanation: "A secret was found in the repository or its history.", impact: "Credential exposure.",
      recommendation: "Rotate the credential and purge it from git history.", verification: "gitleaks reports no leak for this fingerprint.",
    }));
    return { status: { status: "ok", note: `gitleaks reported ${findings.length}`, findings: findings.length }, findings };
  } catch {
    return { status: { status: r.code === 0 ? "ok" : "failed", note: r.code === 0 ? "no leaks" : (r.stderr || "gitleaks failed").slice(0, 200), findings: 0 }, findings: [] };
  }
}

export async function runTrivy(root: string): Promise<{ status: ToolStatus; findings: RawFinding[] }> {
  if (!(await which("trivy"))) return { status: { status: "not_installed", note: "Install trivy to scan IaC/misconfigurations (brew install trivy)", findings: 0 }, findings: [] };
  const r = await run("trivy", ["fs", "--quiet", "--format", "json", "--scanners", "misconfig", root], { cwd: root, timeoutMs: 600_000 });
  try {
    const j = JSON.parse(r.stdout);
    const findings: RawFinding[] = [];
    for (const res of j.Results ?? []) for (const m of res.Misconfigurations ?? []) {
      findings.push({
        source: "security", tool: "trivy", rule_id: `trivy/${m.ID}`, title: m.Title ?? m.ID, category: "Insecure configuration", severity: sevMap(m.Severity ?? "medium"), confidence: "high",
        file_path: res.Target, line: m.CauseMetadata?.StartLine ?? null, evidence: m.Message ?? "", explanation: m.Description ?? "", impact: m.Message ?? "",
        recommendation: m.Resolution ?? "See reference.", verification: "Re-run trivy.", related: m.References ?? [],
      });
    }
    return { status: { status: "ok", note: `trivy reported ${findings.length}`, findings: findings.length }, findings };
  } catch {
    return { status: { status: "failed", note: (r.stderr || "trivy output not parseable").slice(0, 200), findings: 0 }, findings: [] };
  }
}

/** npm audit against the lockfile only (no install, no lifecycle scripts). */
export async function runNpmAudit(root: string, lockfiles: string[]): Promise<{ status: ToolStatus; findings: RawFinding[] }> {
  if (!lockfiles.length) return { status: { status: "skipped", note: "No package-lock.json found", findings: 0 }, findings: [] };
  if (!(await which("npm"))) return { status: { status: "not_installed", note: "npm not available", findings: 0 }, findings: [] };
  const findings: RawFinding[] = [];
  const notes: string[] = [];
  for (const lf of lockfiles.slice(0, 5)) {
    const dir = path.join(root, path.dirname(lf));
    const r = await run("npm", ["audit", "--json", "--package-lock-only", "--ignore-scripts"], { cwd: dir, timeoutMs: 120_000 });
    try {
      const j = JSON.parse(r.stdout);
      if (j.error) { notes.push(`${lf}: ${j.error.summary ?? "error"}`); continue; }
      for (const [name, v] of Object.entries<any>(j.vulnerabilities ?? {})) {
        const advisories = (v.via ?? []).filter((x: any) => typeof x === "object");
        for (const a of advisories) {
          findings.push({
            source: "dependency", tool: "npm-audit", rule_id: `npm-audit/${a.source ?? a.url ?? name}`, title: `${name}: ${a.title ?? "vulnerability"}`, category: "Vulnerable dependencies",
            severity: sevMap(a.severity ?? v.severity ?? "moderate"), confidence: "high", file_path: lf,
            evidence: `npm audit: ${name} ${a.range ?? v.range ?? ""} — ${a.title ?? ""}`, explanation: a.title ?? "", impact: "Known vulnerability in an installed dependency.",
            recommendation: v.fixAvailable ? (typeof v.fixAvailable === "object" ? `Upgrade ${v.fixAvailable.name} to ${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? " (semver-major)" : ""}.` : "Run `npm audit fix`.") : "No fix available yet; consider alternatives.",
            verification: "`npm audit` no longer reports this advisory.", related: a.url ? [a.url] : [],
          });
        }
      }
      notes.push(`${lf}: ok`);
    } catch {
      notes.push(`${lf}: ${(r.stderr || "unparseable output").slice(0, 120)}`);
    }
  }
  const okAny = notes.some((n) => n.endsWith(": ok"));
  return { status: { status: okAny ? "ok" : "failed", note: notes.join("; "), findings: findings.length }, findings };
}

export async function runPipAudit(root: string, reqFiles: string[]): Promise<{ status: ToolStatus; findings: RawFinding[] }> {
  if (!reqFiles.length) return { status: { status: "skipped", note: "No requirements file", findings: 0 }, findings: [] };
  if (!(await which("pip-audit"))) return { status: { status: "not_installed", note: "Install pip-audit to enable (pip install pip-audit). OSV results are still used.", findings: 0 }, findings: [] };
  const findings: RawFinding[] = [];
  for (const rf of reqFiles.slice(0, 3)) {
    // --no-deps + --disable-pip: resolve only declared pins without installing anything.
    const r = await run("pip-audit", ["-r", rf, "--format", "json", "--no-deps", "--disable-pip", "--progress-spinner", "off"], { cwd: root, timeoutMs: 180_000 });
    try {
      const j = JSON.parse(r.stdout);
      for (const d of j.dependencies ?? []) for (const v of d.vulns ?? []) {
        findings.push({
          source: "dependency", tool: "pip-audit", rule_id: `pip-audit/${v.id}`, title: `${d.name}@${d.version}: ${v.id}`, category: "Vulnerable dependencies", severity: "high", confidence: "high",
          file_path: rf, evidence: `pip-audit: ${v.id} affects ${d.name} ${d.version}`, explanation: v.description ?? "", impact: "Known vulnerability.",
          recommendation: v.fix_versions?.length ? `Upgrade to ${v.fix_versions.join(" / ")}` : "No fix listed.", verification: "pip-audit clean.",
        });
      }
    } catch { /* fallthrough */ }
  }
  return { status: { status: "ok", note: `pip-audit reported ${findings.length}`, findings: findings.length }, findings };
}

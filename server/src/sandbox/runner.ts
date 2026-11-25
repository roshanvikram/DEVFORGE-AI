import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, PROJECT_ROOT } from "../config.js";
import { newId } from "../lib/ids.js";
import { run as runPlain } from "../engine/external.js";

/**
 * Isolated execution of repository code (tests, linters).
 *  - docker: `docker run --network none --read-only` with CPU/memory limits (Linux / Docker hosts)
 *  - macos:  `sandbox-exec` profile — no network, writes only inside a throwaway workdir,
 *            reads of credentials directories and DevForge's own data directory denied
 *  - disabled: execution refused (default when no isolation mechanism is available)
 * Code is never executed directly in the API server process or with the server's environment.
 */
export type SandboxMode = "docker" | "macos" | "disabled";

let resolved: { mode: SandboxMode; reason: string } | null = null;
export async function sandboxMode(): Promise<{ mode: SandboxMode; reason: string }> {
  if (resolved) return resolved;
  const want = config.sandboxMode;
  const hasDocker = (await runPlain("/usr/bin/which", ["docker"], { cwd: "/", timeoutMs: 3000 })).code === 0 && (await runPlain("docker", ["info", "--format", "{{.ServerVersion}}"], { cwd: "/", timeoutMs: 8000 })).code === 0;
  const hasMac = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
  if (want === "disabled") resolved = { mode: "disabled", reason: "SANDBOX_MODE=disabled" };
  else if (want === "docker") resolved = hasDocker ? { mode: "docker", reason: "Docker" } : { mode: "disabled", reason: "SANDBOX_MODE=docker but Docker is not available" };
  else if (want === "macos") resolved = hasMac ? { mode: "macos", reason: "macOS sandbox-exec" } : { mode: "disabled", reason: "sandbox-exec not available" };
  else resolved = hasDocker ? { mode: "docker", reason: "Docker detected" } : hasMac ? { mode: "macos", reason: "macOS sandbox-exec" } : { mode: "disabled", reason: "No isolation mechanism (install Docker or set SANDBOX_MODE)" };
  return resolved;
}

export interface SandboxRun { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number; mode: SandboxMode }

function sbString(s: string) {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function macProfile(work: string, allowNetwork: boolean) {
  const home = os.homedir();
  const deniedReads = [".ssh", ".aws", ".config", ".gnupg", ".kube", ".docker", ".netrc", ".npmrc", ".pypirc", ".git-credentials", "Library/Keychains", "Library/Cookies"].map((p) => path.join(home, p));
  const realData = fs.realpathSync(config.dataDir);
  const denied = [...deniedReads, realData, path.join(PROJECT_ROOT, ".env"), path.join(PROJECT_ROOT, "server", ".env")].map((p) => `(subpath ${sbString(p)})`).join(" ");
  return `(version 1)
(allow default)
${allowNetwork ? "" : "(deny network*)\n(allow network* (local unix-socket))"}
(deny file-write*)
(allow file-write* (subpath ${sbString(work)}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/private/var/folders/.*/T/"))
; Deny reading credentials and DevForge's own data (DB, secrets, other repos). Metadata (stat/getcwd
; path resolution) is re-allowed so runtimes can resolve the workdir path through its parents.
(deny file-read* ${denied})
(allow file-read-metadata ${denied})
(allow file-read* (subpath ${sbString(work)}))
`;
}

/** Creates an isolated working copy of the repository (without .git and without DevForge metadata). */
export function prepareWorkdir(repoRoot: string): string {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(config.sandboxDir, "run-")));
  const src = path.join(work, "src");
  fs.cpSync(repoRoot, src, { recursive: true, verbatimSymlinks: true, filter: (p) => !/[/\\]\.git([/\\]|$)/.test(p.slice(repoRoot.length)) });
  fs.mkdirSync(path.join(work, ".home"));
  fs.mkdirSync(path.join(work, ".tmp"));
  return work;
}

export function cleanupWorkdir(work: string) {
  if (work.startsWith(fs.realpathSync(config.sandboxDir))) fs.rmSync(work, { recursive: true, force: true });
}

export async function sandboxExec(work: string, command: string[], opts: { allowNetwork?: boolean; timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal }): Promise<SandboxRun> {
  const { mode } = await sandboxMode();
  if (mode === "disabled") throw new Error("Sandboxed execution is unavailable on this host. Install Docker or run on macOS (sandbox-exec); see docs/SECURITY.md.");
  const src = path.join(work, "src");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    HOME: path.join(work, ".home"),
    TMPDIR: path.join(work, ".tmp"),
    LANG: "C.UTF-8",
    CI: "1",
    NODE_ENV: "test",
    npm_config_cache: path.join(work, ".home", ".npm"),
    PIP_CACHE_DIR: path.join(work, ".home", ".pip"),
    PYTHONDONTWRITEBYTECODE: "1",
    ...(opts.env ?? {}),
  };
  let cmd: string;
  let args: string[];
  if (mode === "macos") {
    const profile = path.join(work, `.profile-${newId()}.sb`);
    fs.writeFileSync(profile, macProfile(work, !!opts.allowNetwork));
    cmd = "/usr/bin/sandbox-exec";
    args = ["-f", profile, ...command];
  } else {
    cmd = "docker";
    const image = process.env.SANDBOX_IMAGE ?? "node:22-bookworm";
    args = ["run", "--rm", "--network", opts.allowNetwork ? "bridge" : "none", "--memory", "2g", "--cpus", "2", "--pids-limit", "512", "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
      "-v", `${work}:/work`, "-w", "/work/src", ...Object.entries({ ...env, HOME: "/work/.home", TMPDIR: "/work/.tmp", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", npm_config_cache: "/work/.home/.npm", PIP_CACHE_DIR: "/work/.home/.pip" }).flatMap(([k, v]) => ["-e", `${k}=${v}`]), image, ...command];
  }
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(cmd, args, { cwd: src, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const t = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs ?? config.sandboxTimeoutMs);
    opts.signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (b) => { if (stdout.length < 2_000_000) stdout += b; });
    child.stderr.on("data", (b) => { if (stderr.length < 1_000_000) stderr += b; });
    child.on("error", (e) => { clearTimeout(t); resolve({ exitCode: null, stdout, stderr: stderr + String(e.message), timedOut, durationMs: Date.now() - started, mode }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - started, mode }); });
  });
}

import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";
import { run } from "./external.js";
import { badRequest, forbidden } from "../lib/errors.js";

/** True for loopback, private, link-local, CGNAT, multicast and reserved ranges (IPv4 + IPv6). */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const x = ip.toLowerCase();
  if (x === "::1" || x === "::") return true;
  if (x.startsWith("fe80") || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("ff")) return true;
  const mapped = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return false;
}

/** Validates a git URL for import: https only, allow-listed host, no credentials, public DNS only (SSRF guard). */
export async function validateGitUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw badRequest("Invalid repository URL");
  }
  if (u.protocol !== "https:") throw badRequest("Only https:// git URLs are supported");
  if (u.username || u.password) throw badRequest("Do not embed credentials in the URL; connect GitHub in Integrations for private repositories");
  if (u.port && u.port !== "443") throw badRequest("Custom ports are not allowed");
  const host = u.hostname.toLowerCase();
  if (net.isIP(host)) throw badRequest("IP-address hosts are not allowed");
  const allowAny = config.gitHostAllowlist.includes("*");
  if (!allowAny && !config.gitHostAllowlist.some((h) => host === h || host.endsWith("." + h))) throw forbidden(`Host ${host} is not in GIT_HOST_ALLOWLIST`);
  if (!/^[\w.\-~/%@+]+$/.test(u.pathname) || u.pathname.includes("..")) throw badRequest("Repository path contains unsupported characters");
  if (u.search || u.hash) throw badRequest("Query strings and fragments are not allowed in repository URLs");
  let addrs: string[] = [];
  try {
    addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw badRequest(`Could not resolve host ${host}`);
  }
  if (!addrs.length || addrs.some(isPrivateAddress)) throw forbidden("Repository host resolves to a private or reserved address");
  return u;
}

/** Ensures `p` (after resolving symlinks) is inside one of the configured local import roots. */
export function validateLocalPath(p: string): string {
  if (!config.localImportRoots.length) throw forbidden("Local import is disabled. Set LOCAL_IMPORT_ROOTS on the server to allow importing from specific directories.");
  const abs = path.resolve(p);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw badRequest("Path does not exist");
  }
  const roots = config.localImportRoots.map((r) => (fs.existsSync(r) ? fs.realpathSync(r) : r));
  if (!roots.some((r) => real === r || real.startsWith(r + path.sep))) throw forbidden("Path is outside the allowed LOCAL_IMPORT_ROOTS");
  if (!fs.statSync(real).isDirectory()) throw badRequest("Path is not a directory");
  return real;
}

function dirSize(dir: string, limit: number): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        total += fs.statSync(p).size;
        if (total > limit) return total;
      }
    }
  }
  return total;
}

const GIT_SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.symlinks=false", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false"];

export async function cloneRepo(url: URL, dest: string, opts: { token?: string | null; branch?: string | null; log: (m: string) => void }): Promise<{ branch: string | null; sha: string | null }> {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const args = [...GIT_SAFE];
  if (opts.token) args.push("-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${opts.token}`).toString("base64")}`);
  args.push("clone", "--depth", "100", "--no-recurse-submodules", "--single-branch");
  if (opts.branch) args.push("--branch", opts.branch);
  args.push("--", url.toString(), dest);
  opts.log(`Cloning ${url.host}${url.pathname}`);
  const r = await run("git", args, { cwd: config.reposDir, timeoutMs: 300_000 });
  if (r.timedOut) throw new Error("git clone timed out");
  if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr.replace(/Authorization: Basic \S+/g, "[auth]").split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300)}`);
  const size = dirSize(dest, config.maxRepoBytes);
  if (size > config.maxRepoBytes) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error(`Repository exceeds the size limit (${Math.round(config.maxRepoBytes / 1024 / 1024)} MB)`);
  }
  return gitHead(dest);
}

export async function gitHead(dir: string): Promise<{ branch: string | null; sha: string | null }> {
  if (!fs.existsSync(path.join(dir, ".git"))) return { branch: null, sha: null };
  const sha = await run("git", [...GIT_SAFE, "rev-parse", "HEAD"], { cwd: dir, timeoutMs: 10_000 });
  const br = await run("git", [...GIT_SAFE, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, timeoutMs: 10_000 });
  return { sha: sha.code === 0 ? sha.stdout.trim() : null, branch: br.code === 0 ? br.stdout.trim() : null };
}

/** Copies a local directory into DevForge storage (the user's working copy is never modified). */
export async function copyLocalRepo(src: string, dest: string, log: (m: string) => void) {
  fs.rmSync(dest, { recursive: true, force: true });
  if (fs.existsSync(path.join(src, ".git"))) {
    log("Cloning local git repository (history preserved)");
    const r = await run("git", [...GIT_SAFE, "clone", "--no-local", "--depth", "100", "--", src, dest], { cwd: config.reposDir, timeoutMs: 300_000 });
    if (r.code === 0) return gitHead(dest);
    log("git clone of local path failed; falling back to file copy");
  }
  const size = dirSize(src, config.maxRepoBytes);
  if (size > config.maxRepoBytes) throw new Error("Directory exceeds the size limit");
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (s) => !/[/\\](node_modules|\.venv|venv|__pycache__|dist|build|\.next)([/\\]|$)/.test(s.slice(src.length)),
  });
  return { branch: null, sha: null };
}

export async function gitCommits(dir: string, limit = 30) {
  if (!fs.existsSync(path.join(dir, ".git"))) return [];
  const r = await run("git", [...GIT_SAFE, "log", `-${limit}`, "--pretty=format:%H%x1f%an%x1f%ae%x1f%aI%x1f%s", "--shortstat"], { cwd: dir, timeoutMs: 20_000 });
  if (r.code !== 0) return [];
  const commits: { sha: string; author: string; date: string; subject: string; files: number; insertions: number; deletions: number }[] = [];
  for (const block of r.stdout.split("\n")) {
    if (block.includes("\x1f")) {
      const [sha, author, , date, subject] = block.split("\x1f");
      commits.push({ sha, author, date, subject, files: 0, insertions: 0, deletions: 0 });
    } else if (/files? changed/.test(block) && commits.length) {
      const c = commits[commits.length - 1];
      c.files = Number(block.match(/(\d+) files? changed/)?.[1] ?? 0);
      c.insertions = Number(block.match(/(\d+) insertion/)?.[1] ?? 0);
      c.deletions = Number(block.match(/(\d+) deletion/)?.[1] ?? 0);
    }
  }
  return commits;
}

export async function gitDiff(dir: string, base: string, head: string): Promise<string> {
  if (!/^[\w./~^-]{1,100}$/.test(base) || !/^[\w./~^-]{1,100}$/.test(head) || base.startsWith("-") || head.startsWith("-")) throw badRequest("Invalid git ref");
  const r = await run("git", [...GIT_SAFE, "diff", "--no-color", "--no-ext-diff", "-U5", `${base}..${head}`, "--"], { cwd: dir, timeoutMs: 30_000, maxBytes: 5 * 1024 * 1024 });
  if (r.code !== 0) throw badRequest(`git diff failed: ${r.stderr.slice(0, 200)}`);
  return r.stdout;
}

export async function gitShow(dir: string, sha: string): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw badRequest("Invalid commit SHA");
  const r = await run("git", [...GIT_SAFE, "show", "--no-color", "--no-ext-diff", "-U5", "--format=commit %H%nAuthor: %an%nDate: %aI%n%n%s%n%b", sha, "--"], { cwd: dir, timeoutMs: 30_000, maxBytes: 5 * 1024 * 1024 });
  if (r.code !== 0) throw badRequest(`Commit not found: ${sha}`);
  return r.stdout;
}

export async function gitPull(dir: string, token: string | null, log: (m: string) => void) {
  const args = [...GIT_SAFE];
  if (token) args.push("-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`);
  args.push("pull", "--ff-only", "--depth", "100", "--no-recurse-submodules");
  const r = await run("git", args, { cwd: dir, timeoutMs: 300_000 });
  if (r.code !== 0) log(`git pull failed (continuing with current checkout): ${r.stderr.split("\n")[0]?.slice(0, 200)}`);
  return gitHead(dir);
}

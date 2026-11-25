import { getGithubToken } from "./integrations.js";
import { HttpError } from "../lib/errors.js";

/** Minimal GitHub REST client (token from workspace integration / env / member OAuth). */
export function parseGithubSlug(url: string | null | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export async function gh(workspaceId: string, pathname: string, init: RequestInit & { accept?: string } = {}): Promise<any> {
  const token = getGithubToken(workspaceId);
  const headers: Record<string, string> = { Accept: init.accept ?? "application/vnd.github+json", "User-Agent": "DevForge-AI", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(`https://api.github.com${pathname}`, { ...init, headers: { ...headers, ...(init.headers as any) }, signal: ctrl.signal });
    if (r.status === 401) throw new HttpError(502, "GitHub rejected the token. Reconnect GitHub in Integrations.", "github_auth");
    if (r.status === 404) throw new HttpError(404, token ? "Not found on GitHub (or the token lacks access)" : "Not found on GitHub. Private repositories require connecting GitHub in Integrations.", "github_not_found");
    if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") throw new HttpError(429, "GitHub API rate limit reached" + (token ? "" : " (unauthenticated: connect GitHub for higher limits)"), "github_rate_limited");
    if (!r.ok) throw new HttpError(502, `GitHub API error ${r.status}`, "github_error");
    return (init.accept ?? "").includes("diff") ? r.text() : r.json();
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Could not reach GitHub: ${e.message}`, "github_unreachable");
  } finally {
    clearTimeout(t);
  }
}

export const githubConfigured = (workspaceId: string) => !!getGithubToken(workspaceId);

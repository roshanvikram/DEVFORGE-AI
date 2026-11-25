/** Typed fetch wrapper: same-origin cookies, CSRF header, workspace header, structured errors. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code: string, public details?: unknown) {
    super(message);
  }
}

let workspaceId: string | null = localStorage.getItem("df.workspace");
export const setWorkspaceId = (id: string | null) => {
  workspaceId = id;
  if (id) localStorage.setItem("df.workspace", id);
  else localStorage.removeItem("df.workspace");
};
export const getWorkspaceId = () => workspaceId;

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "devforge" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (workspaceId) headers["X-Workspace-Id"] = workspaceId;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"), headers, credentials: "same-origin", body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: opts.signal });
  } catch (e: any) {
    if (e?.name === "AbortError") throw e;
    throw new ApiError(0, "Cannot reach the DevForge server. Is it running?", "network");
  }
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const err = (data as any)?.error;
    throw new ApiError(res.status, err?.message ?? `Request failed (${res.status})`, err?.code ?? "error", err?.details);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body: unknown = {}) => api<T>(p, { method: "POST", body });
export const patch = <T = any>(p: string, body: unknown) => api<T>(p, { method: "PATCH", body });
export const put = <T = any>(p: string, body: unknown) => api<T>(p, { method: "PUT", body });
export const del = <T = any>(p: string, body?: unknown) => api<T>(p, { method: "DELETE", body });

/** Download a server-generated file (CSV/Markdown export) using the session cookie. */
export async function download(path: string, filename: string) {
  const headers: Record<string, string> = { "X-Requested-With": "devforge" };
  if (workspaceId) headers["X-Workspace-Id"] = workspaceId;
  const res = await fetch(`/api${path}`, { headers, credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, "Download failed", "download");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

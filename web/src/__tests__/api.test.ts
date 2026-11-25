import { describe, it, expect, vi } from "vitest";

describe("API client", () => {
  it("sends the CSRF and workspace headers on every request", async () => {
    const { api, setWorkspaceId } = await import("../lib/api");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    setWorkspaceId("wsp_test");
    await api("/thing", { method: "POST", body: { a: 1 } });
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("/api/thing");
    expect(init.headers["X-Requested-With"]).toBe("devforge");
    expect(init.headers["X-Workspace-Id"]).toBe("wsp_test");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.credentials).toBe("same-origin");
    expect(localStorage.getItem("df.workspace")).toBe("wsp_test");
  });
  it("surfaces structured server errors", async () => {
    const { api, ApiError } = await import("../lib/api");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "forbidden", message: "Nope" } }), { status: 403, headers: { "content-type": "application/json" } })));
    const err = await api("/x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("forbidden");
    expect(err.message).toBe("Nope");
  });
  it("reports an unreachable server as status 0 (so the UI retries instead of logging out)", async () => {
    const { api } = await import("../lib/api");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await api("/auth/me").catch((e) => e);
    expect(err.status).toBe(0);
    expect(err.code).toBe("network");
  });
});

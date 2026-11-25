/**
 * RAG copilot, quantum-inspired fix-plan optimiser and advisory watch — real services, real jobs, real
 * database; only third-party HTTP APIs (OSV.dev, the AI provider) are replaced by local stand-ins.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import WebSocket from "ws";
import { startStub, GOOD_KEY } from "./stub-anthropic.js";
import { H, makeFixture, signup, waitJob, FIXTURE_ROOT } from "./helpers.js";

let app: any, db: any, config: any, resetLimits: () => void, attachEvents: any;
let rag: typeof import("../src/services/rag.js");
let quantum: typeof import("../src/services/quantum.js");
let u: Awaited<ReturnType<typeof signup>>;
let repoId = "";
let ai: Awaited<ReturnType<typeof startStub>>;

// ── OSV stand-in: advisories can be switched on/off to simulate a newly published vulnerability.
let osvMode: "none" | "vuln" | "down" = "none";
const osv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (osvMode === "down") return res.writeHead(503).end(JSON.stringify({ error: "unavailable" }));
    if (req.url === "/v1/querybatch") {
      const q = JSON.parse(raw).queries as any[];
      return res.end(JSON.stringify({ results: q.map((x) => (osvMode === "vuln" && x.package.name === "lodash" ? { vulns: [{ id: "GHSA-test-0001" }] } : {})) }));
    }
    if (req.url?.startsWith("/v1/vulns/")) return res.end(JSON.stringify({ id: "GHSA-test-0001", summary: "Prototype pollution in lodash", aliases: ["CVE-2099-0001"], database_specific: { severity: "HIGH" }, affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }] }));
    res.writeHead(404).end("{}");
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => osv.listen(0, "127.0.0.1", r));
  process.env.DEVFORGE_OSV_URL = `http://127.0.0.1:${(osv.address() as any).port}`;
  process.env.DEVFORGE_REGISTRY_LOOKUPS = "false";
  ai = await startStub();
  process.env.DEVFORGE_ANTHROPIC_BASE_URL = ai.url;
  delete process.env.ANTHROPIC_API_KEY;
  ({ config } = await import("../src/config.js"));
  config.osvEnabled = true;
  ({ db } = await import("../src/db/db.js"));
  ({ resetLimits } = await import("../src/lib/ratelimit.js"));
  ({ attachEvents } = await import("../src/lib/events.js"));
  rag = await import("../src/services/rag.js");
  quantum = await import("../src/services/quantum.js");
  const { createApp } = await import("../src/app.js");
  const { startWorker } = await import("../src/jobs/queue.js");
  startWorker();
  app = createApp();
  resetLimits();
  u = await signup(app, "intel");
  const dir = makeFixture("intel");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "intel", version: "1.0.0", dependencies: { lodash: "4.17.20" } }));
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "intel", lockfileVersion: 3, packages: { "": { dependencies: { lodash: "4.17.20" } }, "node_modules/lodash": { version: "4.17.20" } } }));
  fs.writeFileSync(path.join(dir, "src", "auth.ts"), `import { find } from "./db";\nexport function loginUser(db: any, userId: string) {\n  const user = find(db, userId);\n  if (!user) throw new Error("unknown user");\n  return { token: "session-" + user.id };\n}\n`);
  const r = await u.agent.post("/api/repositories").set(H).send({ source: "local", path: dir, preset: "full" });
  repoId = r.body.id;
  await waitJob(u.agent, r.body.jobId);
}, 180_000);
beforeEach(() => resetLimits());
afterAll(async () => {
  await ai.close();
  await new Promise((r) => osv.close(r));
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

async function waitQuery(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await u.agent.get(`/api/rag/queries/${id}`);
    if (r.body.status !== "running") return r.body;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("rag query timed out");
}

describe("RAG copilot", () => {
  it("ranks related code above unrelated code with the local embedding", () => {
    const idf = new Float32Array(rag.DIMS).fill(1);
    const q = rag.embed("how does a user log in", idf);
    const login = rag.embed("export function loginUser(db, userId) { const user = find(db, userId) }", idf);
    const other = rag.embed("export const total = add(1, 2); function renderChart(points) {}", idf);
    const cos = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);
    expect(cos(q, login)).toBeGreaterThan(cos(q, other));
  });

  it("builds the index automatically after analysis", async () => {
    const { body: jobs } = await u.agent.get("/api/jobs");
    const idx = jobs.find((j: any) => j.type === "rag.index");
    expect(idx).toBeTruthy();
    await waitJob(u.agent, idx.id);
    const st = await u.agent.get(`/api/repositories/${repoId}/rag`);
    expect(st.body.index.ready).toBe(true);
    expect(st.body.index.chunks).toBeGreaterThanOrEqual(3);
  });

  it("retrieves the right code with hybrid signals, and is honest when no AI is configured", async () => {
    const a = await u.agent.post(`/api/repositories/${repoId}/rag/ask`).set(H).send({ question: "How does loginUser find the user?" });
    expect(a.status).toBe(202);
    const q = await waitQuery(a.body.id);
    expect(q.status).toBe("retrieval_only");
    expect(q.answer).toBeNull();
    expect(q.error).toMatch(/No AI provider/);
    expect(q.sources[0].path).toBe("src/auth.ts");
    expect(Object.keys(q.sources[0].signals).length).toBeGreaterThanOrEqual(2); // fused from several rankers
    expect(q.sources.some((s: any) => s.path === "src/db.ts")).toBe(true); // reached through the import graph / text
  });

  it("streams an AI answer over WebSocket and verifies its citations", async () => {
    process.env.ANTHROPIC_API_KEY = GOOD_KEY;
    const server = http.createServer(app);
    attachEvents(server);
    await new Promise<void>((r) => server.listen(0, r));
    const login = await request(app).post("/api/auth/login").set(H).send({ email: u.email, password: "Test-password-123!" });
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/api/events?workspace=${u.workspaceId}`, { headers: { cookie: String(login.headers["set-cookie"]).split(";")[0] } });
    const events: any[] = [];
    ws.on("message", (d) => events.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on("open", r));
    const a = await u.agent.post(`/api/repositories/${repoId}/rag/ask`).set(H).send({ question: "Where is the find function used?" });
    const q = await waitQuery(a.body.id);
    await new Promise((r) => setTimeout(r, 100));
    ws.close();
    await new Promise((r) => server.close(r));
    delete process.env.ANTHROPIC_API_KEY;
    expect(q.status).toBe("completed");
    expect(q.answer).toContain("src/db.ts:2");
    const phases = events.filter((e) => e.type === "rag" && e.id === a.body.id).map((e) => e.phase);
    expect(phases).toEqual(expect.arrayContaining(["retrieving", "sources", "generating", "token", "done"]));
    const cite = q.citations.find((c: any) => c.ref === "src/db.ts:2");
    expect(cite.verified).toBe(true);
  });

  it("flags citations that do not match retrieved sources", () => {
    const sources: any[] = [{ n: 1, kind: "code", path: "src/db.ts", startLine: 1, endLine: 9 }];
    const c = rag.checkCitations("See [1] and src/db.ts:4, but also [7] and src/ghost.ts:3.", sources);
    expect(c.find((x) => x.ref === "[1]")!.verified).toBe(true);
    expect(c.find((x) => x.ref === "src/db.ts:4")!.verified).toBe(true);
    expect(c.find((x) => x.ref === "[7]")!.verified).toBe(false);
    expect(c.find((x) => x.ref === "src/ghost.ts:3")!.verified).toBe(false);
  });
});

describe("quantum-inspired fix-plan optimiser", () => {
  const mk = (v: number, c: number, file: string | null = null, i = 0): any => ({ id: `f${i}`, title: `f${i}`, source: "bug", severity: "high", file, value: v, cost: c });

  it("beats greedy on an instance where greedy is provably suboptimal", () => {
    const items = [mk(9, 5, null, 0), mk(5, 3, null, 1), mk(5, 3, null, 2)];
    const g = quantum.greedy(items, 6);
    const value = (x: Uint8Array) => items.reduce((a, it, i) => a + (x[i] ? it.value : 0), 0);
    expect(value(g)).toBe(9);
    const { x } = quantum.anneal(items, 6, { seed: 3 });
    expect(value(x)).toBe(10);
    expect(quantum.selectionCost(items, x)).toBeLessThanOrEqual(6);
  });

  it("uses the shared-file discount when it lets more fixes fit", () => {
    const items = [mk(4, 2, "a.ts", 0), mk(4, 2, "a.ts", 1), mk(5, 3, "b.ts", 2)];
    const x = new Uint8Array([1, 1, 0]);
    expect(quantum.selectionCost(items, x)).toBeCloseTo(3.5); // 2 + 2 − 0.25·2
    const { x: best } = quantum.anneal(items, 3.5, { seed: 1 });
    expect(Array.from(best)).toEqual([1, 1, 0]); // value 8 within 3.5h beats the single 5-value fix
  });

  it("runs as a live job over real findings and never exceeds the budget", async () => {
    const info = await u.agent.get(`/api/repositories/${repoId}/optimizer`);
    expect(info.body.candidates).toBeGreaterThan(0);
    const r = await u.agent.post(`/api/repositories/${repoId}/optimizer`).set(H).send({ budgetHours: 3, sweeps: 200 });
    expect(r.status).toBe(202);
    await waitJob(u.agent, r.body.jobId);
    const plan = (await u.agent.get(`/api/fix-plans/${r.body.id}`)).body;
    expect(plan.status).toBe("completed");
    const res = plan.result;
    expect(res.method).toMatch(/classical hardware/);
    expect(res[res.chosen].cost).toBeLessThanOrEqual(3);
    expect(res[res.chosen].value).toBeGreaterThanOrEqual(res.greedy.value);
    expect(res.trace.length).toBeGreaterThan(5);
    expect(res.selected.length).toBe(res[res.chosen].count);
  });

  it("validates optimiser input", async () => {
    const r = await u.agent.post(`/api/repositories/${repoId}/optimizer`).set(H).send({ budgetHours: -1 });
    expect(r.status).toBe(400);
  });
});

describe("advisory watch", () => {
  it("reports a newly published advisory for an unchanged repository, then its removal", async () => {
    osvMode = "vuln";
    const c1 = await u.agent.post(`/api/repositories/${repoId}/advisories/check`).set(H).send({});
    expect(c1.status).toBe(202);
    const j1 = await waitJob(u.agent, c1.body.jobId);
    expect(j1.status).toBe("completed");
    let st = await u.agent.get(`/api/repositories/${repoId}/advisories`);
    expect(st.body.history[0].status).toBe("ok");
    expect(st.body.history[0].new_advisories).toEqual(["GHSA-test-0001|lodash"]);
    expect(st.body.vulnerablePackages).toBe(1);
    const f = await u.agent.get(`/api/findings?repo=${repoId}&limit=200`);
    expect((f.body.items ?? f.body).some((x: any) => x.rule_id === "vuln/GHSA-test-0001" && x.status === "open")).toBe(true);
    const n = db().prepare(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'advisory' AND workspace_id = ?`).get(u.workspaceId);
    expect(n.n).toBeGreaterThanOrEqual(1);

    osvMode = "none";
    const c2 = await u.agent.post(`/api/repositories/${repoId}/advisories/check`).set(H).send({});
    await waitJob(u.agent, c2.body.jobId);
    st = await u.agent.get(`/api/repositories/${repoId}/advisories`);
    expect(st.body.history[0].resolved_advisories).toEqual(["GHSA-test-0001|lodash"]);
    expect(st.body.vulnerablePackages).toBe(0);
  });

  it("records a failed check honestly when OSV is unreachable", async () => {
    osvMode = "down";
    const c = await u.agent.post(`/api/repositories/${repoId}/advisories/check`).set(H).send({});
    await waitJob(u.agent, c.body.jobId);
    const st = await u.agent.get(`/api/repositories/${repoId}/advisories`);
    expect(st.body.history[0].status).toBe("failed");
    expect(st.body.history[0].new_advisories).toEqual([]);
    osvMode = "none";
  });

  it("lets admins switch the watch off", async () => {
    const r = await u.agent.put("/api/advisory-watch").set(H).send({ enabled: false });
    expect(r.body.enabled).toBe(false);
    expect((await u.agent.get(`/api/repositories/${repoId}/advisories`)).body.enabled).toBe(false);
  });
});

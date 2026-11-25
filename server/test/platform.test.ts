import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import request from "supertest";
import WebSocket from "ws";
import { createApp } from "../src/app.js";
import { db } from "../src/db/db.js";
import { config } from "../src/config.js";
import { startWorker } from "../src/jobs/queue.js";
import { attachEvents } from "../src/lib/events.js";
import { resetLimits } from "../src/lib/ratelimit.js";
import { isPrivateAddress, validateGitUrl } from "../src/engine/ingest.js";
import { encryptSecret, decryptSecret } from "../src/lib/crypto.js";
import { redact } from "../src/lib/logger.js";
import { verifySignature } from "../src/services/realtime.js";
import { can } from "../src/auth/rbac.js";
import { H, makeFixture, signup, waitJob, FIXTURE_ROOT } from "./helpers.js";

const app = createApp();
let owner: Awaited<ReturnType<typeof signup>>;
let repoId = "";
let analysis: any;

beforeAll(async () => {
  db();
  startWorker();
  resetLimits();
  owner = await signup(app, "owner");
  const dir = makeFixture("flawed");
  const r = await owner.agent.post("/api/repositories").set(H).send({ source: "local", path: dir, preset: "full" });
  expect(r.status).toBe(201);
  repoId = r.body.id;
  analysis = await waitJob(owner.agent, r.body.jobId);
}, 120_000);

beforeEach(() => resetLimits());

afterAll(() => {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

/* ───────────── 1. Auth & sessions ───────────── */
describe("auth", () => {
  it("rejects state-changing requests without the CSRF header", async () => {
    const r = await request(app).post("/api/auth/login").send({ email: "a@b.test", password: "x" });
    expect(r.status).toBe(403);
  });
  it("rejects cross-origin requests", async () => {
    const r = await request(app).post("/api/auth/login").set(H).set("Origin", "https://evil.example").send({ email: "a@b.test", password: "x" });
    expect(r.status).toBe(403);
  });
  it("rejects weak passwords", async () => {
    const r = await request(app).post("/api/auth/register").set(H).send({ name: "x", email: "weak@devforge.test", password: "short" });
    expect(r.status).toBe(400);
  });
  it("refuses duplicate registration", async () => {
    const r = await request(app).post("/api/auth/register").set(H).send({ name: "dup", email: owner.email, password: "Test-password-123!" });
    expect(r.status).toBe(409);
  });
  it("logs in with correct credentials and rejects wrong ones", async () => {
    const bad = await request(app).post("/api/auth/login").set(H).send({ email: owner.email, password: "Wrong-password-1" });
    expect(bad.status).toBe(401);
    const ok = await request(app).post("/api/auth/login").set(H).send({ email: owner.email, password: "Test-password-123!" });
    expect(ok.status).toBe(200);
    expect(String(ok.headers["set-cookie"])).toMatch(/df_session=.*HttpOnly/i);
  });
  it("stores only hashed session tokens", async () => {
    const rows = db().prepare(`SELECT * FROM sessions LIMIT 5`).all() as any[];
    for (const s of rows) expect(JSON.stringify(s)).not.toMatch(/"token":/);
  });
  it("requires authentication for workspace APIs", async () => {
    expect((await request(app).get("/api/dashboard")).status).toBe(401);
  });
});

/* ───────────── 2. Tenant isolation & RBAC ───────────── */
describe("tenancy and permissions", () => {
  it("blocks access to another workspace's repository", async () => {
    const other = await signup(app, "intruder");
    const r = await other.agent.get(`/api/repositories/${repoId}`);
    expect(r.status).toBe(404);
    const forced = await other.agent.get(`/api/repositories/${repoId}`).set("X-Workspace-Id", owner.workspaceId);
    expect(forced.status).toBe(403);
  });
  it("enforces role permissions in the backend", () => {
    expect(can("viewer", "analysis.run")).toBe(false);
    expect(can("viewer", "workspace.view")).toBe(true);
    expect(can("engineer", "secrets.manage")).toBe(false);
    expect(can("owner", "workspace.delete")).toBe(true);
  });
});

/* ───────────── 3. Ingestion safety ───────────── */
describe("ingestion safety", () => {
  it("classifies private and loopback addresses (SSRF guard)", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["140.82.112.3", "8.8.8.8"]) expect(isPrivateAddress(ip)).toBe(false);
  });
  it("rejects non-https, credentialed and non-allow-listed git URLs", async () => {
    await expect(validateGitUrl("http://github.com/a/b")).rejects.toThrow();
    await expect(validateGitUrl("https://user:pw@github.com/a/b")).rejects.toThrow();
    await expect(validateGitUrl("https://internal.corp.example/a/b")).rejects.toThrow();
    await expect(validateGitUrl("https://127.0.0.1/a/b")).rejects.toThrow();
  });
  it("refuses local imports outside LOCAL_IMPORT_ROOTS", async () => {
    const r = await owner.agent.post("/api/repositories").set(H).send({ source: "local", path: "/etc" });
    expect(r.status).toBe(403);
  });
});

/* ───────────── 4. Real analysis results ───────────── */
describe("analysis engine", () => {
  it("completes a full analysis job on a real repository", () => {
    expect(analysis.status).toBe("completed");
    expect(analysis.result.files).toBeGreaterThanOrEqual(3);
  });
  it("detects SQL injection, eval and unsafe deserialization", async () => {
    const r = await owner.agent.get(`/api/findings?repo=${repoId}&limit=200`);
    const rules = new Set((r.body.items ?? r.body).map((f: any) => f.rule_id));
    expect(rules.has("sec/sql-injection-js")).toBe(true);
    expect(rules.has("sec/eval")).toBe(true);
    expect(rules.has("sec/unsafe-deserialization")).toBe(true);
  });
  it("detects hard-coded credentials and masks the value", async () => {
    const r = await owner.agent.get(`/api/findings?repo=${repoId}&limit=200`);
    const secret = (r.body.items ?? r.body).find((f: any) => f.rule_id === "secret/aws-access-key");
    expect(secret).toBeTruthy();
    expect(JSON.stringify(secret)).not.toContain("AKIAQ3EXAMPLE7TES");
  });
  it("reports no findings for a clean repository", async () => {
    const dir = makeFixture("clean", { clean: true });
    const r = await owner.agent.post("/api/repositories").set(H).send({ source: "local", path: dir, preset: "quick" });
    const job = await waitJob(owner.agent, r.body.jobId);
    expect(job.status).toBe("completed");
    const f = await owner.agent.get(`/api/findings?repo=${r.body.id}&limit=200`);
    const items = (f.body.items ?? f.body).filter((x: any) => x.source === "security" || x.source === "secret");
    expect(items.length).toBe(0);
  });
  it("indexes code for full-text search", async () => {
    const r = await owner.agent.get(`/api/repositories/${repoId}/search?q=pickle`);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain("app.py");
  });
  it("serves file contents but blocks path traversal", async () => {
    const ok = await owner.agent.get(`/api/repositories/${repoId}/file?path=src/util.ts`);
    expect(ok.status).toBe(200);
    const bad = await owner.agent.get(`/api/repositories/${repoId}/file?path=../../../etc/passwd`);
    expect([400, 403, 404]).toContain(bad.status);
  });
  it("builds the architecture graph from real imports", async () => {
    const r = await owner.agent.get(`/api/repositories/${repoId}/architecture`);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain("src/util.ts");
  });
});

/* ───────────── 5. Findings workflow ───────────── */
describe("findings", () => {
  it("updates status and records an audit event", async () => {
    const list = await owner.agent.get(`/api/findings?repo=${repoId}&limit=200`);
    const f = (list.body.items ?? list.body)[0];
    const r = await owner.agent.patch(`/api/findings/${f.id}`).set(H).send({ status: "triaged", note: "looking" });
    expect(r.status).toBe(200);
    const d = await owner.agent.get(`/api/findings/${f.id}`);
    expect(d.body.status ?? d.body.finding?.status).toBe("triaged");
  });
  it("rejects invalid status values", async () => {
    const list = await owner.agent.get(`/api/findings?repo=${repoId}&limit=1`);
    const f = (list.body.items ?? list.body)[0];
    const r = await owner.agent.patch(`/api/findings/${f.id}`).set(H).send({ status: "deleted" });
    expect(r.status).toBe(400);
  });
});

/* ───────────── 6. NEW: health score history ───────────── */
describe("feature: health history", () => {
  it("records a health snapshot after each analysis", async () => {
    const r = await owner.agent.get(`/api/repositories/${repoId}/health`);
    expect(r.status).toBe(200);
    expect(r.body.history.length).toBeGreaterThanOrEqual(1);
    expect(r.body.current.score).toBeGreaterThanOrEqual(0);
    expect(r.body.current.score).toBeLessThanOrEqual(100);
    expect(Object.keys(r.body.current.breakdown).sort()).toEqual(["maintainability", "performance", "reliability", "security"]);
  });
  it("adds a new history point and delta on re-scan", async () => {
    const before = (await owner.agent.get(`/api/repositories/${repoId}/health`)).body.history.length;
    const s = await owner.agent.post(`/api/repositories/${repoId}/analyze`).set(H).send({ kinds: ["security"] });
    await waitJob(owner.agent, s.body.jobId);
    const after = await owner.agent.get(`/api/repositories/${repoId}/health`);
    expect(after.body.history.length).toBe(before + 1);
    expect(typeof after.body.delta).toBe("number");
  });
});

/* ───────────── 7. NEW: quality gates ───────────── */
describe("feature: quality gates", () => {
  it("fails the gate when critical findings exceed the limit", async () => {
    const put = await owner.agent.put("/api/quality-gate").set(H).send({ enabled: true, min_score: null, max_critical: 0, max_high: null, max_secrets: 0, max_vulnerable_deps: null });
    expect(put.status).toBe(200);
    const r = await owner.agent.post("/api/quality-gate/evaluate").set(H).send({ repositoryId: repoId });
    expect(r.status).toBe(200);
    expect(r.body.passed).toBe(false);
    expect(r.body.checks.find((c: any) => c.key === "max_secrets").passed).toBe(false);
  });
  it("passes when thresholds are met and keeps a result history", async () => {
    await owner.agent.put("/api/quality-gate").set(H).send({ enabled: true, min_score: 0, max_critical: 1000, max_high: 1000, max_secrets: 1000, max_vulnerable_deps: 1000 });
    const r = await owner.agent.post("/api/quality-gate/evaluate").set(H).send({ repositoryId: repoId });
    expect(r.body.passed).toBe(true);
    const list = await owner.agent.get("/api/quality-gate");
    expect(list.body.results.length).toBeGreaterThanOrEqual(2);
  });
  it("notifies members when a gate fails", async () => {
    const n = db().prepare(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'gate' AND workspace_id = ?`).get(owner.workspaceId) as any;
    expect(n.n).toBeGreaterThanOrEqual(1);
  });
  it("validates gate thresholds", async () => {
    const r = await owner.agent.put("/api/quality-gate").set(H).send({ enabled: true, min_score: 140, max_critical: null, max_high: null, max_secrets: null, max_vulnerable_deps: null });
    expect(r.status).toBe(400);
  });
});

/* ───────────── 8. NEW: auto-sync & webhooks ───────────── */
describe("feature: auto-sync and webhooks", () => {
  it("refuses to watch local imports (no remote)", async () => {
    const r = await owner.agent.put(`/api/repositories/${repoId}/watch`).set(H).send({ enabled: true, intervalMin: 15, preset: "quick" });
    expect(r.status).toBe(400);
  });
  it("verifies HMAC webhook signatures in constant time", () => {
    const body = Buffer.from('{"ref":"refs/heads/main"}');
    const sig = "sha256=" + crypto.createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(verifySignature("s3cret", body, sig)).toBe(true);
    expect(verifySignature("other", body, sig)).toBe(false);
    expect(verifySignature("s3cret", body, undefined)).toBe(false);
  });
  it("accepts signed pushes, rejects forged ones and stores the secret encrypted", async () => {
    // Simulate a git-backed repository row (no network needed for the receiver itself).
    const id = "rep_webhooktest";
    db().prepare(`INSERT INTO repositories (id, workspace_id, name, source_type, source_url, default_branch, local_path, status) VALUES (?,?,?,?,?,?,?, 'ready')`).run(id, owner.workspaceId, "hook/test", "git", "https://github.com/example/hook", "main", "/nonexistent");
    const created = await owner.agent.post(`/api/repositories/${id}/webhook`).set(H).send({});
    expect(created.status).toBe(200);
    const secret = created.body.secret as string;
    const stored = (db().prepare(`SELECT webhook_secret FROM repositories WHERE id = ?`).get(id) as any).webhook_secret;
    expect(stored).not.toContain(secret);
    expect((await owner.agent.get(`/api/repositories/${id}/watch`)).body.webhook).not.toHaveProperty("secret");

    const payload = JSON.stringify({ ref: "refs/heads/feature-x", after: "abc" });
    const forged = await request(app).post(`/api/hooks/github/${id}`).set("Content-Type", "application/json").set("X-GitHub-Event", "push").set("X-Hub-Signature-256", "sha256=" + "0".repeat(64)).send(payload);
    expect(forged.status).toBe(401);
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const ignored = await request(app).post(`/api/hooks/github/${id}`).set("Content-Type", "application/json").set("X-GitHub-Event", "push").set("X-Hub-Signature-256", sig).send(payload);
    expect(ignored.status).toBe(202);
    expect(ignored.body.message).toMatch(/non-tracked/);
    const deliveries = (await owner.agent.get(`/api/repositories/${id}/watch`)).body.deliveries;
    expect(deliveries.map((d: any) => d.status)).toEqual(expect.arrayContaining(["rejected", "ignored"]));
  });
  it("returns 404 for webhooks that are not configured", async () => {
    const r = await request(app).post(`/api/hooks/github/rep_doesnotexist`).set("Content-Type", "application/json").send("{}");
    expect(r.status).toBe(404);
  });
});

/* ───────────── 9. NEW: presence & live ops ───────────── */
describe("feature: realtime presence and live ops", () => {
  it("broadcasts presence over the WebSocket hub", async () => {
    const server = http.createServer(app);
    attachEvents(server);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    const login = await request(app).post("/api/auth/login").set(H).send({ email: owner.email, password: "Test-password-123!" });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events?workspace=${owner.workspaceId}`, { headers: { cookie } });
    const msgs: any[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "presence", path: "/app/live" }));
    await new Promise((r) => setTimeout(r, 300));
    const last = msgs.filter((m) => m.type === "presence").pop();
    expect(last.users[0].path).toBe("/app/live");
    const p = await owner.agent.get("/api/presence");
    expect(p.body.users.length).toBe(1);
    ws.close();
    await new Promise((r) => server.close(r));
  });
  it("rejects WebSocket connections without a session", async () => {
    const server = http.createServer(app);
    attachEvents(server);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events?workspace=${owner.workspaceId}`);
    const outcome = await new Promise((r) => {
      ws.on("open", () => r("open"));
      ws.on("error", () => r("error"));
      ws.on("close", () => r("closed"));
    });
    expect(outcome).not.toBe("open");
    await new Promise((r) => server.close(r));
  });
  it("reports measured live operations metrics", async () => {
    const r = await owner.agent.get("/api/system/live");
    expect(r.status).toBe(200);
    expect(r.body.worker.concurrency).toBeGreaterThan(0);
    expect(r.body.process.rssMb).toBeGreaterThan(0);
    expect(r.body.jobs.durations.find((d: any) => d.type === "repo.import").n).toBeGreaterThanOrEqual(1);
    expect(r.body.database.bytes).toBeGreaterThan(0);
  });
});

/* ───────────── 10. Secrets handling ───────────── */
describe("secrets", () => {
  it("encrypts and decrypts secrets with AES-GCM", () => {
    const blob = encryptSecret("value-123");
    expect(blob).not.toContain("value-123");
    expect(decryptSecret(blob)).toBe("value-123");
    expect(decryptSecret(blob.slice(0, -4) + "AAAA")).toBeNull();
  });
  it("redacts credentials from logs", () => {
    const fake = ["ghp", "_", "a".repeat(36)].join("");
    expect(redact(`token ${fake}`)).not.toContain(fake);
  });
  it("never returns saved API keys from the integrations API", async () => {
    const r = await owner.agent.get("/api/integrations");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/sk-ant-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}/);
  });
});

/* ───────────── 11. Dashboard ───────────── */
describe("dashboard", () => {
  it("returns real counts consistent with the findings table", async () => {
    const r = await owner.agent.get("/api/dashboard");
    const n = (db().prepare(`SELECT COUNT(*) AS n FROM findings WHERE workspace_id = ? AND review_id IS NULL AND status IN ('open','triaged','in_progress')`).get(owner.workspaceId) as any).n;
    expect(r.body.findings.total).toBe(n);
  });
  it("returns an empty state for a workspace with no repositories", async () => {
    const fresh = await signup(app, "fresh");
    const r = await fresh.agent.get("/api/dashboard");
    expect(r.body.empty).toBe(true);
  });
});

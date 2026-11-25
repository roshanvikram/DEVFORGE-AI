/**
 * AI integration tests. DevForge's real provider code (Anthropic SDK, streaming, tool loop, structured
 * output, usage accounting, error mapping) runs against a local stand-in for the Messages API.
 * These prove DevForge's side of the integration; they do not exercise Claude's model quality.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import { startStub, GOOD_KEY, BAD_KEY, NO_CREDIT_KEY } from "./stub-anthropic.js";
import { H, makeFixture, signup, waitJob, FIXTURE_ROOT } from "./helpers.js";

let stub: Awaited<ReturnType<typeof startStub>>;
let app: any, db: any, resetLimits: () => void;
let u: Awaited<ReturnType<typeof signup>>;
let repoId = "";

beforeAll(async () => {
  stub = await startStub();
  process.env.DEVFORGE_ANTHROPIC_BASE_URL = stub.url;
  delete process.env.ANTHROPIC_API_KEY;
  ({ db } = await import("../src/db/db.js"));
  ({ resetLimits } = await import("../src/lib/ratelimit.js"));
  const { createApp } = await import("../src/app.js");
  const { startWorker } = await import("../src/jobs/queue.js");
  startWorker();
  app = createApp();
  resetLimits();
  u = await signup(app, "ai");
  const r = await u.agent.post("/api/repositories").set(H).send({ source: "local", path: makeFixture("ai"), preset: "full" });
  repoId = r.body.id;
  await waitJob(u.agent, r.body.jobId);
}, 120_000);
beforeEach(() => resetLimits());
afterAll(async () => {
  await stub.close();
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

async function waitRun(id: string) {
  for (let i = 0; i < 200; i++) {
    const r = await u.agent.get(`/api/agent-runs/${id}`);
    if (["completed", "failed", "cancelled"].includes(r.body.status)) return r.body;
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error("agent run timed out");
}

describe("AI provider configuration", () => {
  it("reports AI as not configured and degrades to evidence-only Q&A", async () => {
    const caps = await u.agent.get("/api/system/capabilities");
    expect(caps.body.ai.configured).toBe(false);
    const q = await u.agent.post(`/api/repositories/${repoId}/chat`).set(H).send({ question: "Where are users queried?" });
    expect(q.body.aiConfigured).toBe(false);
    expect(q.body.answer).toBeNull();
    expect(q.body.citations.length).toBeGreaterThan(0);
  });
  it("rejects an API key the provider refuses, and does not store it", async () => {
    const r = await u.agent.put("/api/integrations/anthropic").set(H).send({ secret: BAD_KEY });
    expect(r.status).toBe(400);
    const row = db().prepare(`SELECT COUNT(*) AS n FROM integrations WHERE workspace_id = ? AND provider = 'anthropic'`).get(u.workspaceId);
    expect(row.n).toBe(0);
  });
  it("verifies and stores a valid key encrypted, never echoing it back", async () => {
    const r = await u.agent.put("/api/integrations/anthropic").set(H).send({ secret: GOOD_KEY });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(GOOD_KEY);
    const all = JSON.stringify(db().prepare(`SELECT * FROM integrations WHERE workspace_id = ?`).all(u.workspaceId));
    expect(all).not.toContain(GOOD_KEY);
    expect(JSON.stringify((await u.agent.get("/api/integrations")).body)).not.toContain(GOOD_KEY);
    expect((await u.agent.get("/api/system/capabilities")).body.ai.configured).toBe(true);
  });
});

describe("AI features through the real provider code", () => {
  it("answers repository questions with retrieved code, citations and usage accounting", async () => {
    const before = stub.requests.length;
    const r = await u.agent.post(`/api/repositories/${repoId}/chat`).set(H).send({ question: "How does find query users?" });
    expect(r.status).toBe(200);
    expect(r.body.answer).toContain("src/db.ts");
    expect(r.body.citations.length).toBeGreaterThan(0);
    const sent = stub.requests.slice(before).find((x) => x.path.startsWith("/v1/messages"))!;
    expect(sent.headers.authorization ?? sent.headers["x-api-key"]).toContain(GOOD_KEY);
    expect(sent.body.model).toBe("claude-opus-5-5");
    expect(sent.body.stream).toBe(true);
    // Retrieval-bounded context, never the whole repository.
    expect(JSON.stringify(sent.body.messages).length).toBeLessThan(60_000);
    const usage = db().prepare(`SELECT * FROM ai_usage WHERE workspace_id = ? AND feature = 'repository_chat'`).get(u.workspaceId);
    expect(usage.ok).toBe(1);
    expect(usage.input_tokens).toBe(1200);
    expect(usage.output_tokens).toBe(300);
    expect(usage.cost_usd).toBeGreaterThan(0);
  });

  it("runs an agent's tool loop: the model calls a real tool and reports on its real output", async () => {
    const run = await u.agent.post("/api/agent-runs").set(H).send({ repositoryId: repoId, agent: "security_auditor", task: "Summarise security risks" });
    expect(run.status).toBe(201);
    const done = await waitRun(run.body.id);
    expect(done.status).toBe("completed");
    expect(done.ai_used).toBe(1);
    expect(done.output).toContain("SQL injection is present in src/db.ts");
    const kinds = done.stepLog.map((s: any) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(["plan", "tool_call"]));
    const toolReq = stub.requests.filter((x) => x.body?.tools?.length);
    expect(toolReq.length).toBe(2);
    expect(toolReq[0].body.tools.map((t: any) => t.name)).toContain("list_findings");
    expect(toolReq[0].body.tools.map((t: any) => t.name)).not.toContain("save_document"); // only the agent's allowed tools
  });

  it("produces AI hypotheses that are labelled as hypotheses, with invented files flagged and patches never applied", async () => {
    const r = await u.agent.post("/api/investigations").set(H).send({ repositoryId: repoId, title: "Users endpoint returns every row", error: "Unexpected result count", stackTrace: "Error: too many rows\n    at find (src/db.ts:3:10)" });
    await waitJob(u.agent, r.body.jobId);
    const inv = (await u.agent.get(`/api/investigations/${r.body.id}`)).body;
    expect(inv.status).toBe("completed");
    const ai = inv.hypotheses.filter((h: any) => h.origin === "ai_hypothesis");
    expect(ai.length).toBe(2);
    expect(ai.find((h: any) => h.title.startsWith("Unvalidated")).verification).toMatch(/cited files exist/);
    expect(ai.find((h: any) => h.title === "Invented module").verification).toMatch(/not found/);
    expect(inv.proposed_fix.origin).toBe("ai");
    expect(inv.proposed_fix.applied).toBe(false);
    const sent = stub.requests.find((x) => x.body?.output_config?.format?.type === "json_schema")!;
    expect(sent.body.output_config.format.schema.required).toEqual(["hypotheses", "proposed_fix"]);
  });

  it("maps a revoked key to a clear error without leaking the key", async () => {
    db().prepare(`DELETE FROM integrations WHERE workspace_id = ?`).run(u.workspaceId);
    process.env.ANTHROPIC_API_KEY = BAD_KEY;
    const r = await u.agent.post(`/api/repositories/${repoId}/chat`).set(H).send({ question: "What does find do?" });
    delete process.env.ANTHROPIC_API_KEY;
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("ai_auth");
    expect(JSON.stringify(r.body)).not.toContain(BAD_KEY);
    const failed = db().prepare(`SELECT error FROM ai_usage WHERE workspace_id = ? AND ok = 0`).all(u.workspaceId);
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(failed)).not.toContain(BAD_KEY);
  });

  it("explains an account with no API credit instead of a generic failure", async () => {
    process.env.ANTHROPIC_API_KEY = NO_CREDIT_KEY;
    const r = await u.agent.post(`/api/repositories/${repoId}/chat`).set(H).send({ question: "What does find do?" });
    delete process.env.ANTHROPIC_API_KEY;
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe("ai_billing");
    expect(r.body.error.message).toMatch(/credit/i);
  });

  it("enforces the monthly AI budget before calling the provider", async () => {
    process.env.ANTHROPIC_API_KEY = GOOD_KEY;
    const s = await u.agent.patch("/api/settings").set(H).send({ ai: { monthlyBudgetUsd: 0.000001 } });
    expect(s.status).toBe(200);
    const before = stub.requests.length;
    const r = await u.agent.post(`/api/repositories/${repoId}/chat`).set(H).send({ question: "Anything?" });
    delete process.env.ANTHROPIC_API_KEY;
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("ai_budget");
    expect(stub.requests.length).toBe(before);
  });
});

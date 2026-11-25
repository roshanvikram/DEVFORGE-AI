/**
 * Groq provider: DevForge's real Groq code path (OpenAI-compatible chat completions, tool calling,
 * JSON output, error mapping, key handling) against a local stand-in for the Groq API.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import { startGroqStub, GROQ_GOOD, GROQ_RATE_LIMITED } from "./stub-groq.js";
import { H, makeFixture, signup, waitJob, FIXTURE_ROOT } from "./helpers.js";

let stub: Awaited<ReturnType<typeof startGroqStub>>;
let app: any, db: any, resetLimits: () => void, redact: (s: string) => string;
let u: Awaited<ReturnType<typeof signup>>;
let repoId = "";

beforeAll(async () => {
  stub = await startGroqStub();
  process.env.DEVFORGE_GROQ_BASE_URL = stub.url;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
  ({ db } = await import("../src/db/db.js"));
  ({ resetLimits } = await import("../src/lib/ratelimit.js"));
  ({ redact } = await import("../src/lib/logger.js"));
  const { createApp } = await import("../src/app.js");
  const { startWorker } = await import("../src/jobs/queue.js");
  startWorker();
  app = createApp();
  resetLimits();
  u = await signup(app, "groq");
  const r = await u.agent.post("/api/repositories").set(H).send({ source: "local", path: makeFixture("groq"), preset: "full" });
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

describe("Groq provider", () => {
  it("rejects a Groq key that Groq refuses and stores a valid one encrypted", async () => {
    const bad = await u.agent.put("/api/integrations/groq").set(H).send({ secret: "test-groq-invalid-9999" });
    expect(bad.status).toBe(400);
    const ok = await u.agent.put("/api/integrations/groq").set(H).send({ secret: GROQ_GOOD });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(db().prepare(`SELECT * FROM integrations WHERE workspace_id = ?`).all(u.workspaceId))).not.toContain(GROQ_GOOD);
    const list = await u.agent.get("/api/integrations");
    const groq = list.body.find((i: any) => i.provider === "groq");
    expect(groq.status).toBe("connected");
    expect(JSON.stringify(list.body)).not.toContain(GROQ_GOOD);
  });

  it("is used automatically when it is the only connected provider", async () => {
    const st = await u.agent.get("/api/settings");
    expect(st.body.ai.configured).toBe(true);
    expect(st.body.ai.provider).toBe("groq");
    expect(st.body.ai.model).toBe("llama-3.3-70b-versatile");
    expect(st.body.groqModels).toContain("openai/gpt-oss-120b");
  });

  it("answers repository questions through Groq chat completions", async () => {
    const before = stub.requests.length;
    const r = await u.agent.post(`/api/repositories/${repoId}/chat`).set(H).send({ question: "How does find query users?" });
    expect(r.status).toBe(200);
    expect(r.body.answer).toContain("Groq says");
    const sent = stub.requests.slice(before).find((x) => x.path === "/openai/v1/chat/completions")!;
    expect(sent.headers.authorization).toBe(`Bearer ${GROQ_GOOD}`);
    expect(sent.body.model).toBe("llama-3.3-70b-versatile");
    expect(sent.body.messages[0].role).toBe("system");
    const usage = db().prepare(`SELECT * FROM ai_usage WHERE workspace_id = ? AND feature = 'repository_chat' AND ok = 1`).get(u.workspaceId);
    expect(usage.model).toBe("groq:llama-3.3-70b-versatile");
    expect(usage.input_tokens).toBe(900);
    expect(usage.output_tokens).toBe(150);
  });

  it("runs an agent tool loop with OpenAI-style tool calls and tool results", async () => {
    const before = stub.requests.length;
    const run = await u.agent.post("/api/agent-runs").set(H).send({ repositoryId: repoId, agent: "security_auditor", task: "Summarise security risks" });
    const done = await waitRun(run.body.id);
    expect(done.status).toBe("completed");
    expect(done.output).toContain("SQL injection found in src/db.ts");
    const calls = stub.requests.slice(before).filter((x) => x.body?.tools?.length);
    expect(calls.length).toBe(2);
    expect(calls[0].body.tools[0].type).toBe("function");
    const second = calls[1].body.messages;
    const assistant = second.find((m: any) => m.role === "assistant" && m.tool_calls);
    const tool = second.find((m: any) => m.role === "tool");
    expect(assistant.tool_calls[0].function.name).toBe("list_findings");
    expect(tool.tool_call_id).toBe("call_stub_1");
  });

  it("produces labelled AI hypotheses using JSON output mode", async () => {
    const before = stub.requests.length;
    const r = await u.agent.post("/api/investigations").set(H).send({ repositoryId: repoId, title: "All users returned", stackTrace: "Error: too many rows\n    at find (src/db.ts:3:10)" });
    await waitJob(u.agent, r.body.jobId);
    const inv = (await u.agent.get(`/api/investigations/${r.body.id}`)).body;
    const ai = inv.hypotheses.filter((h: any) => h.origin === "ai_hypothesis");
    expect(ai.length).toBe(1);
    expect(inv.proposed_fix.applied).toBe(false);
    const sent = stub.requests.slice(before).find((x) => x.body?.response_format)!;
    expect(sent.body.response_format.type).toBe("json_object");
    expect(sent.body.messages[0].content).toContain("JSON Schema");
  });

  it("maps a rejected key and rate limiting to clear errors without leaking keys", async () => {
    db().prepare(`DELETE FROM integrations WHERE workspace_id = ? AND provider = 'groq'`).run(u.workspaceId);
    process.env.GROQ_API_KEY = "test-groq-revoked-7777";
    const denied = await u.agent.post(`/api/repositories/${repoId}/chat`).set(H).send({ question: "What does find do?" });
    expect(denied.status).toBe(502);
    expect(denied.body.error.code).toBe("ai_auth");
    expect(denied.body.error.message).toMatch(/Groq/);
    process.env.GROQ_API_KEY = GROQ_RATE_LIMITED;
    const limited = await u.agent.post(`/api/repositories/${repoId}/chat`).set(H).send({ question: "What does find do?" });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("ai_rate_limited");
    delete process.env.GROQ_API_KEY;
    expect(JSON.stringify(db().prepare(`SELECT error FROM ai_usage WHERE ok = 0`).all())).not.toContain("test-groq-revoked-7777");
  });

  it("honours an explicit provider choice and redacts Groq keys from logs", async () => {
    process.env.GROQ_API_KEY = GROQ_GOOD;
    await u.agent.patch("/api/settings").set(H).send({ ai: { provider: "anthropic" } });
    const st = await u.agent.get("/api/settings");
    expect(st.body.ai.configured).toBe(false); // Claude chosen but not connected: no silent fallback
    await u.agent.patch("/api/settings").set(H).send({ ai: { provider: "groq", groqModel: "openai/gpt-oss-20b" } });
    const st2 = await u.agent.get("/api/settings");
    expect(st2.body.ai.provider).toBe("groq");
    expect(st2.body.ai.model).toBe("openai/gpt-oss-20b");
    delete process.env.GROQ_API_KEY;
    const fake = "gsk_" + "A".repeat(52);
    expect(redact(`key=${fake}`)).not.toContain(fake);
  });
});

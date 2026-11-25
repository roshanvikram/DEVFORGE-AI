/**
* Live smoke tests against the real Claude and Groq APIs. Each runs only when its key (ANTHROPIC_API_KEY / GROQ_API_KEY) is set
 * (e.g. `ANTHROPIC_API_KEY=... npm run test:live --workspace server`); skipped otherwise. Costs a few cents.
 */
import { describe, it, expect } from "vitest";

const key = process.env.ANTHROPIC_API_KEY;
describe.skipIf(!key)("live Claude API", () => {
  it("completes a structured-output request through DevForge's provider", async () => {
    delete process.env.DEVFORGE_ANTHROPIC_BASE_URL;
    const { db } = await import("../src/db/db.js");
    const { providerFor, parseJson } = await import("../src/ai/provider.js");
    const { newId } = await import("../src/lib/ids.js");
    const ws = newId("wsp_");
    const org = newId("org_");
    const uid = newId("usr_");
    db().prepare(`INSERT INTO users (id, email, name) VALUES (?,?,?)`).run(uid, `${uid}@devforge.test`, "live");
    db().prepare(`INSERT INTO organizations (id, name, slug, owner_id) VALUES (?,?,?,?)`).run(org, "live", org, uid);
    db().prepare(`INSERT INTO workspaces (id, org_id, name, slug) VALUES (?,?,?,?)`).run(ws, org, "live", "live");
    const ai = providerFor(ws, null)!;
    expect(ai).toBeTruthy();
    const r = await ai.complete({
      feature: "live_smoke",
      system: "Reply with JSON only.",
      maxTokens: 2000,
      jsonSchema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "integer" } } },
      messages: [{ role: "user", content: "What is 17 + 25?" }],
    });
    expect(parseJson<{ answer: number }>(r.text).answer).toBe(42);
    expect(r.usage.costUsd).toBeGreaterThan(0);
  });
});

/** Live Groq smoke test. Runs only when GROQ_API_KEY is set; skipped otherwise. */
describe.skipIf(!process.env.GROQ_API_KEY)("live Groq API", () => {
  it("completes a JSON request and a tool call through DevForge's Groq provider", async () => {
    delete process.env.DEVFORGE_GROQ_BASE_URL;
    const groqKey = process.env.GROQ_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // force the Groq path
    const { db } = await import("../src/db/db.js");
    const { providerFor, parseJson } = await import("../src/ai/provider.js");
    const { newId } = await import("../src/lib/ids.js");
    const uid = newId("usr_"), org = newId("org_"), ws = newId("wsp_");
    db().prepare(`INSERT INTO users (id, email, name) VALUES (?,?,?)`).run(uid, `${uid}@devforge.test`, "live");
    db().prepare(`INSERT INTO organizations (id, name, slug, owner_id) VALUES (?,?,?,?)`).run(org, "live", org, uid);
    db().prepare(`INSERT INTO workspaces (id, org_id, name, slug) VALUES (?,?,?,?)`).run(ws, org, "live", "live");
    process.env.GROQ_API_KEY = groqKey;
    const ai = providerFor(ws, null)!;
    expect(ai.id).toBe("groq");
    const r = await ai.complete({
      feature: "live_smoke", system: "Reply with JSON only.", maxTokens: 500,
      jsonSchema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "integer" } } },
      messages: [{ role: "user", content: "What is 17 + 25?" }],
    });
    expect(parseJson<{ answer: number }>(r.text).answer).toBe(42);
    const t = await ai.complete({
      feature: "live_smoke", system: "Use the tool to answer.", maxTokens: 500,
      tools: [{ name: "get_weather", description: "Get the weather for a city", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } as any],
      messages: [{ role: "user", content: "What's the weather in Paris? Call the tool." }],
    });
    const call: any = t.content.find((b: any) => b.type === "tool_use");
    expect(call?.name).toBe("get_weather");
    expect(String(call?.input?.city).toLowerCase()).toContain("paris");
    expect(r.usage.input).toBeGreaterThan(0);
  });
});

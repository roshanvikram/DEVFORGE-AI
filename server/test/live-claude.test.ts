/**
 * Live smoke test against the real Claude API. Runs only when ANTHROPIC_API_KEY is set
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

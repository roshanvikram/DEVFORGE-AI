import { describe, it, expect } from "vitest";
import { describeEvent } from "../lib/events";

const at = new Date().toISOString();
describe("live event descriptions", () => {
  it("describes job progress and completion", () => {
    expect(describeEvent({ type: "job", at, jobType: "repo.import", status: "running", progress: 0.42, message: "Indexing" })).toBe("repo.import running · 42% — Indexing");
    expect(describeEvent({ type: "job", at, jobType: "repo.import", status: "completed" })).toBe("repo.import completed");
  });
  it("describes health deltas with sign", () => {
    expect(describeEvent({ type: "health", at, score: 91, delta: 3 })).toBe("Health score 91 (+3)");
    expect(describeEvent({ type: "health", at, score: 88, delta: -3 })).toBe("Health score 88 (-3)");
    expect(describeEvent({ type: "health", at, score: 88, delta: null })).toBe("Health score 88");
  });
  it("lists failed gate checks", () => {
    expect(describeEvent({ type: "gate", at, passed: false, failed: ["Health score", "Exposed secrets"] })).toBe("Quality gate failed: Health score, Exposed secrets");
    expect(describeEvent({ type: "gate", at, passed: true })).toBe("Quality gate passed");
  });
  it("describes remote checks, webhooks, presence and repositories", () => {
    expect(describeEvent({ type: "watch", at, status: "updated", remoteSha: "0123456789abcdef" })).toBe("Remote check: updated @ 01234567");
    expect(describeEvent({ type: "webhook", at, event: "push", status: "queued" })).toBe("Webhook push queued");
    expect(describeEvent({ type: "presence", at, users: [{}, {}] })).toBe("2 online");
    expect(describeEvent({ type: "repository", at, status: "indexing" })).toBe("Repository indexing");
    expect(describeEvent({ type: "activity", at, action: "repository.auto_sync" })).toBe("Repository Auto Sync");
  });
});

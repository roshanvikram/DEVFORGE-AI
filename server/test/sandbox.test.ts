/**
 * Sandboxed execution of repository code (macOS sandbox-exec). Skipped on hosts without it.
 * Proves: the repository's own tests run and are parsed, and the sandbox blocks network access,
 * writes outside the workdir and reads of DevForge's own data directory.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { H, makeFixture, signup, waitJob } from "./helpers.js";

process.env.SANDBOX_MODE = "macos";
const hasSandbox = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");

describe.skipIf(!hasSandbox)("sandboxed execution (macOS)", () => {
  let mod: typeof import("../src/sandbox/runner.js");
  let config: typeof import("../src/config.js")["config"];
  let work = "";
  beforeAll(async () => {
    mod = await import("../src/sandbox/runner.js");
    config = (await import("../src/config.js")).config;
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "df-sbx-"));
    fs.writeFileSync(path.join(repo, "sum.test.mjs"), `import test from "node:test";\nimport assert from "node:assert";\ntest("adds", () => assert.equal(1 + 1, 2));\ntest("fails on purpose", () => assert.equal(1 + 1, 3));\n`);
    work = mod.prepareWorkdir(repo);
  });

  it("detects macOS sandbox mode", async () => {
    expect((await mod.sandboxMode()).mode).toBe("macos");
  });
  it("runs the repository's own tests inside the sandbox", async () => {
    const r = await mod.sandboxExec(work, [process.execPath, "--test", "--test-reporter=tap", "sum.test.mjs"], { timeoutMs: 60_000 });
    expect(r.mode).toBe("macos");
    expect(r.stdout).toMatch(/^# pass 1$/m);
    expect(r.stdout).toMatch(/^# fail 1$/m);
    expect(r.exitCode).not.toBe(0);
  });
  it("blocks network access", async () => {
    const r = await mod.sandboxExec(work, [process.execPath, "-e", `require("node:https").get("https://example.com",()=>process.exit(0)).on("error",e=>{console.log("NETERR",e.code);process.exit(3)})`], { timeoutMs: 20_000 });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain("NETERR");
  });
  it("blocks writes outside the workdir", async () => {
    const target = path.join(os.homedir(), `df-sandbox-escape-${Date.now()}.txt`);
    const r = await mod.sandboxExec(work, [process.execPath, "-e", `try{require("fs").writeFileSync(${JSON.stringify(target)},"x");console.log("WROTE")}catch(e){console.log("DENIED",e.code)}`], { timeoutMs: 20_000 });
    expect(r.stdout).toContain("DENIED");
    expect(fs.existsSync(target)).toBe(false);
  });
  it("blocks reading DevForge's own data (database, secrets)", async () => {
    fs.writeFileSync(path.join(config.dataDir, "probe.txt"), "secret-data");
    const probe = path.join(fs.realpathSync(config.dataDir), "probe.txt");
    const r = await mod.sandboxExec(work, [process.execPath, "-e", `try{console.log("READ",require("fs").readFileSync(${JSON.stringify(probe)},"utf8"))}catch(e){console.log("DENIED",e.code)}`], { timeoutMs: 20_000 });
    expect(r.stdout).toContain("DENIED");
    expect(r.stdout).not.toContain("secret-data");
  });
  it("does not leak the server's environment variables", async () => {
    process.env.DF_TEST_SECRET_ENV = "should-not-leak";
    const r = await mod.sandboxExec(work, [process.execPath, "-e", `console.log(process.env.DF_TEST_SECRET_ENV ?? "absent")`], { timeoutMs: 20_000 });
    expect(r.stdout.trim()).toBe("absent");
    mod.cleanupWorkdir(work);
    expect(fs.existsSync(work)).toBe(false);
  });

  it("runs a repository's test suite end to end through the API and records real results", async () => {
    const { createApp } = await import("../src/app.js");
    const { startWorker } = await import("../src/jobs/queue.js");
    const { resetLimits } = await import("../src/lib/ratelimit.js");
    resetLimits();
    startWorker();
    const app = createApp();
    const u = await signup(app, "sandbox");
    const dir = makeFixture("suite", { clean: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "suite", version: "1.0.0", scripts: { test: "node --test --test-reporter=tap" } }));
    fs.writeFileSync(path.join(dir, "math.test.mjs"), `import test from "node:test";\nimport assert from "node:assert";\ntest("one", () => assert.ok(true));\ntest("two", () => assert.ok(true));\ntest("three", () => assert.equal(2, 3));\n`);
    const imp = await u.agent.post("/api/repositories").set(H).send({ source: "local", path: dir, preset: "quick" });
    expect(imp.status).toBe(201);
    await waitJob(u.agent, imp.body.jobId);
    const run = await u.agent.post("/api/tests").set(H).send({ repositoryId: imp.body.id, kind: "suite" });
    expect(run.status).toBe(201);
    const job = await waitJob(u.agent, run.body.jobId, 120_000);
    const detail = await u.agent.get(`/api/tests/${run.body.id}`);
    expect(job.status).toBe("completed");
    expect(detail.body.passed).toBe(2);
    expect(detail.body.failed).toBe(1);
    expect(detail.body.status).toBe("failed");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";

export const FIXTURE_ROOT = path.join(os.tmpdir(), "devforge-test-fixtures");
export const H = { "X-Requested-With": "devforge" };

/**
 * Writes a small, deliberately flawed project. Secret-like values are assembled at runtime
 * so this source file never contains a literal credential pattern.
 */
export function makeFixture(name: string, opts: { clean?: boolean } = {}) {
  const dir = path.join(FIXTURE_ROOT, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies: {} }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "util.ts"), `export function add(a: number, b: number) {\n  return a + b;\n}\n`);
  if (!opts.clean) {
    const fakeKey = ["AKIA", "Q3EXAMPLE7TESTKEY".slice(0, 16)].join("");
    fs.writeFileSync(
      path.join(dir, "src", "db.ts"),
      [
        `import { add } from "./util";`,
        `export function find(db: any, id: string) {`,
        "  return db.query(`SELECT * FROM users WHERE id = ${id}`);",
        `}`,
        `export function run(code: string) {`,
        `  return eval(code);`,
        `}`,
        `export const awsKey = "${fakeKey}";`,
        `export const total = add(1, 2);`,
      ].join("\n"),
    );
    fs.writeFileSync(path.join(dir, "app.py"), `import pickle\n\ndef load(blob):\n    return pickle.loads(blob)\n`);
  }
  return dir;
}

export async function signup(app: Express, label = "user") {
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@devforge.test`;
  const reg = await agent.post("/api/auth/register").set(H).send({ name: label, email, password: "Test-password-123!" });
  if (reg.status !== 201) throw new Error(`register failed ${reg.status} ${JSON.stringify(reg.body)}`);
  const ws = await agent.post("/api/workspaces").set(H).send({ name: `${label} workspace` });
  return { agent, email, userId: reg.body.user?.id ?? reg.body.id, workspaceId: ws.body.id as string };
}

export async function waitJob(agent: ReturnType<typeof request.agent>, jobId: string, timeoutMs = 90_000) {
  const start = Date.now();
  for (;;) {
    const r = await agent.get(`/api/jobs/${jobId}`);
    if (["completed", "failed", "cancelled"].includes(r.body.status)) return r.body;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} timed out (status ${r.body.status})`);
    await new Promise((res) => setTimeout(res, 250));
  }
}

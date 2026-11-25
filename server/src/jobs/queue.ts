import { db, now, json } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { publish } from "../lib/events.js";
import { log as slog, redact } from "../lib/logger.js";

/**
 * Persistent background job queue (SQLite-backed). Jobs survive restarts as records;
 * jobs interrupted by a restart are marked failed (and re-queued if attempts remain).
 */
export interface JobCtx {
  id: string;
  workspaceId: string;
  userId: string | null;
  payload: any;
  signal: AbortSignal;
  log: (message: string, level?: "info" | "warn" | "error") => void;
  progress: (p: number, message?: string) => void;
}
type Handler = (ctx: JobCtx) => Promise<unknown>;

const handlers = new Map<string, Handler>();
const running = new Map<string, AbortController>();
let timer: NodeJS.Timeout | null = null;
const CONCURRENCY = Number(process.env.JOB_CONCURRENCY ?? 2);

export function workerState() {
  return { concurrency: CONCURRENCY, running: running.size, handlers: [...handlers.keys()].sort() };
}

export function registerHandler(type: string, h: Handler) {
  handlers.set(type, h);
}

/** Run a registered handler inline inside another job (used by workflows to avoid worker-slot deadlocks). */
export async function runInline(type: string, parent: JobCtx, payload: unknown): Promise<unknown> {
  const h = handlers.get(type);
  if (!h) throw new Error(`No handler registered for ${type}`);
  return h({ ...parent, payload, progress: () => {} });
}

export function enqueue(type: string, workspaceId: string, payload: unknown, opts: { userId?: string | null; maxAttempts?: number } = {}): string {
  const id = newId("job_");
  db().prepare(`INSERT INTO jobs (id, workspace_id, type, payload, max_attempts, created_by) VALUES (?,?,?,?,?,?)`).run(id, workspaceId, type, JSON.stringify(payload ?? {}), opts.maxAttempts ?? 1, opts.userId ?? null);
  publish(workspaceId, { type: "job", id, status: "queued", jobType: type });
  setImmediate(tick);
  return id;
}

export function cancelJob(id: string): boolean {
  const ctrl = running.get(id);
  if (ctrl) {
    ctrl.abort();
    return true;
  }
  const r = db().prepare(`UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'`).run(now(), id);
  return r.changes > 0;
}

export function retryJob(id: string): string | null {
  const j = db().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as any;
  if (!j || !["failed", "cancelled"].includes(j.status)) return null;
  return enqueue(j.type, j.workspace_id, json(j.payload, {}), { userId: j.created_by, maxAttempts: j.max_attempts });
}

function addLog(jobId: string, level: string, message: string) {
  db().prepare(`INSERT INTO job_logs (job_id, level, message) VALUES (?,?,?)`).run(jobId, level, redact(message).slice(0, 4000));
}

async function execute(job: any) {
  const h = handlers.get(job.type);
  const ctrl = new AbortController();
  running.set(job.id, ctrl);
  const d = db();
  d.prepare(`UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?`).run(now(), job.id);
  publish(job.workspace_id, { type: "job", id: job.id, status: "running", jobType: job.type });
  let lastProgressEmit = 0;
  const ctx: JobCtx = {
    id: job.id,
    workspaceId: job.workspace_id,
    userId: job.created_by,
    payload: json(job.payload, {}),
    signal: ctrl.signal,
    log: (m, level = "info") => {
      addLog(job.id, level, m);
      publish(job.workspace_id, { type: "job.log", id: job.id, level, message: redact(m).slice(0, 500) });
    },
    progress: (p, m) => {
      // Throttle: indexers report progress per file; persist + broadcast at most ~4×/s.
      if (Date.now() - lastProgressEmit > 250 || p >= 1) {
        lastProgressEmit = Date.now();
        d.prepare(`UPDATE jobs SET progress = ?, message = COALESCE(?, message) WHERE id = ?`).run(Math.max(0, Math.min(1, p)), m ?? null, job.id);
        publish(job.workspace_id, { type: "job", id: job.id, status: "running", progress: p, message: m, jobType: job.type });
      }
    },
  };
  try {
    if (!h) throw new Error(`No handler registered for job type ${job.type}`);
    const result = await h(ctx);
    if (ctrl.signal.aborted) throw new Error("cancelled");
    d.prepare(`UPDATE jobs SET status = 'completed', progress = 1, result = ?, finished_at = ? WHERE id = ?`).run(JSON.stringify(result ?? null), now(), job.id);
    publish(job.workspace_id, { type: "job", id: job.id, status: "completed", progress: 1, jobType: job.type });
  } catch (e: any) {
    const cancelled = ctrl.signal.aborted || e?.message === "cancelled";
    const msg = cancelled ? "Cancelled by user" : redact(String(e?.message ?? e)).slice(0, 1000);
    addLog(job.id, "error", msg);
    const attempts = job.attempts + 1;
    if (!cancelled && attempts < job.max_attempts) {
      d.prepare(`UPDATE jobs SET status = 'queued', error = ? WHERE id = ?`).run(msg, job.id);
      addLog(job.id, "warn", `Retrying (attempt ${attempts + 1} of ${job.max_attempts})`);
    } else {
      d.prepare(`UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?`).run(cancelled ? "cancelled" : "failed", msg, now(), job.id);
      publish(job.workspace_id, { type: "job", id: job.id, status: cancelled ? "cancelled" : "failed", error: msg, jobType: job.type });
    }
    if (!cancelled) slog.warn("job failed", { id: job.id, type: job.type, error: msg });
  } finally {
    running.delete(job.id);
    setImmediate(tick);
  }
}

function tick() {
  if (running.size >= CONCURRENCY) return;
  const free = CONCURRENCY - running.size;
  const jobs = db().prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT ?`).all(free) as any[];
  for (const j of jobs) {
    if (running.has(j.id)) continue;
    void execute(j);
  }
}

export function startWorker() {
  // Recover jobs interrupted by a restart.
  const stuck = db().prepare(`SELECT id, attempts, max_attempts FROM jobs WHERE status = 'running'`).all() as any[];
  for (const j of stuck) {
    if (j.attempts < j.max_attempts) db().prepare(`UPDATE jobs SET status = 'queued' WHERE id = ?`).run(j.id);
    else db().prepare(`UPDATE jobs SET status = 'failed', error = 'Interrupted by server restart', finished_at = ? WHERE id = ?`).run(now(), j.id);
  }
  timer = setInterval(tick, 1000);
  timer.unref();
  tick();
}

/** Await a job's completion (used by workflows and agents that chain work). */
export async function waitForJob(id: string, signal?: AbortSignal, timeoutMs = 30 * 60_000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const j = db().prepare(`SELECT status, result, error FROM jobs WHERE id = ?`).get(id) as any;
    if (!j) throw new Error("job not found");
    if (j.status === "completed") return json(j.result, null);
    if (j.status === "failed" || j.status === "cancelled") throw new Error(j.error ?? j.status);
    if (signal?.aborted) {
      cancelJob(id);
      throw new Error("cancelled");
    }
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for job");
    await new Promise((r) => setTimeout(r, 400));
  }
}

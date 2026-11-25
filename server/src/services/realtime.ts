import crypto from "node:crypto";
import { db, now, json } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { publish } from "../lib/events.js";
import { audit, notify } from "../lib/audit.js";
import { log } from "../lib/logger.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";
import { healthScore } from "./metrics.js";
import { enqueue } from "../jobs/queue.js";
import { validateGitUrl, gitRemoteHead } from "../engine/ingest.js";
import { getGithubToken } from "./integrations.js";

/* ───────────────────────── Health history ───────────────────────── */

const OPEN = `status IN ('open','triaged','in_progress') AND review_id IS NULL AND origin = 'detected'`;

/** Records the repository's current health score (derived only from persisted findings). */
export function recordHealth(repoId: string, trigger = "analysis") {
  const d = db();
  const repo = d.prepare(`SELECT id, workspace_id, current_snapshot_id FROM repositories WHERE id = ?`).get(repoId) as any;
  if (!repo?.current_snapshot_id) return null;
  const h = healthScore(repoId);
  if (h.score == null) return null;
  const snap = d.prepare(`SELECT commit_sha, loc FROM snapshots WHERE id = ?`).get(repo.current_snapshot_id) as any;
  const c = d.prepare(`SELECT COUNT(*) AS n, SUM(severity = 'critical') AS critical, SUM(severity = 'high') AS high FROM findings WHERE repository_id = ? AND ${OPEN}`).get(repoId) as any;
  const prev = d.prepare(`SELECT score FROM health_history WHERE repository_id = ? ORDER BY id DESC LIMIT 1`).get(repoId) as { score: number } | undefined;
  const b = h.breakdown as Record<string, number>;
  d.prepare(
    `INSERT INTO health_history (repository_id, snapshot_id, commit_sha, score, reliability, security, performance, maintainability, open_findings, critical, high, loc, trigger) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(repoId, repo.current_snapshot_id, snap?.commit_sha ?? null, h.score, b.reliability, b.security, b.performance, b.maintainability, c.n ?? 0, c.critical ?? 0, c.high ?? 0, snap?.loc ?? null, trigger);
  const delta = prev ? h.score - prev.score : null;
  publish(repo.workspace_id, { type: "health", repositoryId: repoId, score: h.score, delta, breakdown: b });
  return { score: h.score, delta, breakdown: b };
}

export function healthHistory(repoId: string, limit = 60) {
  return (db()
    .prepare(`SELECT score, reliability, security, performance, maintainability, open_findings, critical, high, loc, commit_sha, trigger, created_at FROM health_history WHERE repository_id = ? ORDER BY id DESC LIMIT ?`)
    .all(repoId, limit) as any[]).reverse();
}

/* ───────────────────────── Quality gates ───────────────────────── */

export type Gate = { enabled: boolean; min_score: number | null; max_critical: number | null; max_high: number | null; max_secrets: number | null; max_vulnerable_deps: number | null; updated_at?: string };

export function getGate(workspaceId: string): Gate | null {
  const g = db().prepare(`SELECT * FROM quality_gates WHERE workspace_id = ?`).get(workspaceId) as any;
  return g ? { ...g, enabled: !!g.enabled } : null;
}

export function setGate(workspaceId: string, userId: string, g: Omit<Gate, "updated_at">) {
  db()
    .prepare(
      `INSERT INTO quality_gates (workspace_id, enabled, min_score, max_critical, max_high, max_secrets, max_vulnerable_deps, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(workspace_id) DO UPDATE SET enabled=excluded.enabled, min_score=excluded.min_score, max_critical=excluded.max_critical, max_high=excluded.max_high, max_secrets=excluded.max_secrets, max_vulnerable_deps=excluded.max_vulnerable_deps, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    )
    .run(workspaceId, g.enabled ? 1 : 0, g.min_score, g.max_critical, g.max_high, g.max_secrets, g.max_vulnerable_deps, userId, now());
  return getGate(workspaceId)!;
}

export type GateCheck = { key: string; label: string; threshold: number; actual: number | null; passed: boolean; comparator: ">=" | "<=" };

/** Evaluates the workspace gate against the repository's *recorded* state. Returns null when there is nothing to evaluate. */
export function evaluateGate(repoId: string, trigger: string) {
  const d = db();
  const repo = d.prepare(`SELECT id, name, workspace_id, current_snapshot_id FROM repositories WHERE id = ?`).get(repoId) as any;
  if (!repo?.current_snapshot_id) return null;
  const gate = getGate(repo.workspace_id);
  if (!gate?.enabled) return null;
  const counts = d.prepare(`SELECT SUM(severity = 'critical') AS critical, SUM(severity = 'high') AS high, SUM(source = 'secret') AS secrets FROM findings WHERE repository_id = ? AND ${OPEN}`).get(repoId) as any;
  const vulnerable = (d.prepare(`SELECT COUNT(*) AS n FROM dependencies WHERE snapshot_id = ? AND vulns != '[]'`).get(repo.current_snapshot_id) as any).n as number;
  const score = healthScore(repoId).score;
  const checks: GateCheck[] = [];
  const max = (key: string, label: string, threshold: number | null, actual: number) => {
    if (threshold != null) checks.push({ key, label, threshold, actual, passed: actual <= threshold, comparator: "<=" });
  };
  if (gate.min_score != null) checks.push({ key: "min_score", label: "Health score", threshold: gate.min_score, actual: score, passed: score != null && score >= gate.min_score, comparator: ">=" });
  max("max_critical", "Open critical findings", gate.max_critical, counts.critical ?? 0);
  max("max_high", "Open high findings", gate.max_high, counts.high ?? 0);
  max("max_secrets", "Exposed secrets", gate.max_secrets, counts.secrets ?? 0);
  max("max_vulnerable_deps", "Vulnerable dependencies", gate.max_vulnerable_deps, vulnerable);
  if (!checks.length) return null;
  const passed = checks.every((c) => c.passed);
  const prev = d.prepare(`SELECT passed FROM gate_results WHERE repository_id = ? ORDER BY created_at DESC LIMIT 1`).get(repoId) as { passed: number } | undefined;
  const id = newId("gate_");
  d.prepare(`INSERT INTO gate_results (id, workspace_id, repository_id, snapshot_id, passed, checks, trigger) VALUES (?,?,?,?,?,?,?)`).run(id, repo.workspace_id, repoId, repo.current_snapshot_id, passed ? 1 : 0, JSON.stringify(checks), trigger);
  publish(repo.workspace_id, { type: "gate", id, repositoryId: repoId, passed, failed: checks.filter((c) => !c.passed).map((c) => c.label) });
  // Notify on failures and on recovery — not on every passing run.
  if (!passed) notify({ workspaceId: repo.workspace_id, kind: "gate", title: `Quality gate failed: ${repo.name}`, body: checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.actual ?? "n/a"} (limit ${c.comparator} ${c.threshold})`).join("; "), link: `/app/gates?repo=${repoId}` });
  else if (prev && !prev.passed) notify({ workspaceId: repo.workspace_id, kind: "gate", title: `Quality gate passing again: ${repo.name}`, link: `/app/gates?repo=${repoId}` });
  return { id, passed, checks };
}

export function gateResults(workspaceId: string, repoId?: string | null, limit = 50) {
  return (db()
    .prepare(`SELECT g.id, g.repository_id, r.name AS repository, g.passed, g.checks, g.trigger, g.created_at FROM gate_results g JOIN repositories r ON r.id = g.repository_id WHERE g.workspace_id = ? ${repoId ? "AND g.repository_id = ?" : ""} ORDER BY g.created_at DESC LIMIT ?`)
    .all(workspaceId, ...(repoId ? [repoId] : []), limit) as any[]).map((g) => ({ ...g, passed: !!g.passed, checks: json(g.checks, []) }));
}

/** Called by the analysis pipeline after every completed analysis. Never throws. */
export function afterAnalysis(repoId: string, trigger: string) {
  try {
    const health = recordHealth(repoId, trigger);
    const gate = evaluateGate(repoId, trigger);
    return { health, gate };
  } catch (e: any) {
    log.warn("post-analysis hooks failed", { repoId, error: String(e?.message ?? e) });
    return { health: null, gate: null };
  }
}

/* ───────────────────────── Auto-sync (remote polling) ───────────────────────── */

const PRESET_KINDS: Record<string, string[]> = {
  quick: ["bug", "security", "debt"],
  full: ["bug", "security", "dependency", "performance", "debt"],
  security: ["security", "dependency"],
};

function activeJobFor(repoId: string) {
  return db().prepare(`SELECT id FROM jobs WHERE status IN ('queued','running') AND type IN ('repo.import','repo.analyze') AND json_extract(payload, '$.repositoryId') = ? LIMIT 1`).get(repoId) as { id: string } | undefined;
}

/** Checks one repository's remote head; enqueues a refresh + analysis when a new commit appears. */
export async function checkRemote(repoId: string, trigger: "auto-sync" | "manual" = "auto-sync"): Promise<{ status: "updated" | "unchanged" | "busy" | "unsupported" | "error"; remoteSha?: string | null; jobId?: string; error?: string }> {
  const d = db();
  const repo = d.prepare(`SELECT r.*, s.commit_sha FROM repositories r LEFT JOIN snapshots s ON s.id = r.current_snapshot_id WHERE r.id = ?`).get(repoId) as any;
  if (!repo) return { status: "error", error: "not found" };
  if (repo.source_type === "local") return { status: "unsupported", error: "Local imports have no remote to watch" };
  const busy = activeJobFor(repoId);
  if (busy) return { status: "busy", jobId: busy.id };
  try {
    const url = await validateGitUrl(repo.source_url);
    const token = repo.source_type === "github" ? getGithubToken(repo.workspace_id) : null;
    const sha = await gitRemoteHead(url, repo.default_branch, token);
    d.prepare(`UPDATE repositories SET watch_last_checked_at = ?, watch_remote_sha = ?, watch_last_error = NULL WHERE id = ?`).run(now(), sha, repoId);
    if (sha && sha !== repo.commit_sha) {
      const jobId = enqueue("repo.import", repo.workspace_id, { repositoryId: repoId, kinds: PRESET_KINDS[repo.watch_preset] ?? PRESET_KINDS.quick, refresh: true, trigger }, { userId: null });
      audit({ workspaceId: repo.workspace_id, actorType: "system", action: "repository.auto_sync", entityType: "repository", entityId: repoId, data: { from: repo.commit_sha, to: sha, trigger } });
      publish(repo.workspace_id, { type: "watch", repositoryId: repoId, status: "updated", remoteSha: sha, jobId });
      return { status: "updated", remoteSha: sha, jobId };
    }
    publish(repo.workspace_id, { type: "watch", repositoryId: repoId, status: "unchanged", remoteSha: sha });
    return { status: "unchanged", remoteSha: sha };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 300);
    d.prepare(`UPDATE repositories SET watch_last_checked_at = ?, watch_last_error = ? WHERE id = ?`).run(now(), msg, repoId);
    publish(repo.workspace_id, { type: "watch", repositoryId: repoId, status: "error", error: msg });
    return { status: "error", error: msg };
  }
}

let watchTimer: NodeJS.Timeout | null = null;
let watching = false;
export function startWatcher(intervalMs = 30_000) {
  if (watchTimer) return;
  watchTimer = setInterval(async () => {
    if (watching) return;
    watching = true;
    try {
      const due = db()
        .prepare(
          `SELECT id FROM repositories WHERE watch_enabled = 1 AND source_type != 'local' AND status = 'ready'
           AND (watch_last_checked_at IS NULL OR watch_last_checked_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now', '-' || watch_interval_min || ' minutes'))
           ORDER BY watch_last_checked_at LIMIT 5`,
        )
        .all() as { id: string }[];
      for (const r of due) await checkRemote(r.id);
    } catch (e: any) {
      log.warn("watcher tick failed", { error: String(e?.message ?? e) });
    } finally {
      watching = false;
    }
  }, intervalMs);
  watchTimer.unref();
}

/* ───────────────────────── Signed push webhooks ───────────────────────── */

/** Generates a new webhook secret. The plaintext is returned once; only ciphertext is stored. */
export function rotateWebhookSecret(repoId: string): string {
  const secret = crypto.randomBytes(24).toString("base64url");
  db().prepare(`UPDATE repositories SET webhook_secret = ? WHERE id = ?`).run(encryptSecret(secret), repoId);
  return secret;
}

export function verifySignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex"));
  const got = Buffer.from(header);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

export function handleWebhook(repoId: string, raw: Buffer | undefined, headers: Record<string, string | string[] | undefined>, body: any): { status: number; message: string; jobId?: string } {
  const d = db();
  const repo = d.prepare(`SELECT id, workspace_id, name, default_branch, webhook_secret, watch_preset FROM repositories WHERE id = ?`).get(repoId) as any;
  // Same response for unknown repo and missing secret: don't reveal which repositories exist.
  const secret = repo ? decryptSecret(repo.webhook_secret) : null;
  if (!repo || !secret) return { status: 404, message: "Webhook not configured" };
  const event = String(headers["x-github-event"] ?? "");
  const delivery = String(headers["x-github-delivery"] ?? "").slice(0, 100) || null;
  const record = (status: string, detail: string, jobId?: string) => {
    d.prepare(`INSERT INTO webhook_deliveries (id, repository_id, event, delivery_id, status, detail, job_id) VALUES (?,?,?,?,?,?,?)`).run(newId("whd_"), repoId, event || null, delivery, status, detail, jobId ?? null);
    d.prepare(`UPDATE repositories SET webhook_last_delivery_at = ? WHERE id = ?`).run(now(), repoId);
    publish(repo.workspace_id, { type: "webhook", repositoryId: repoId, event, status, jobId });
  };
  if (!raw || !verifySignature(secret, raw, headers["x-hub-signature-256"] as string | undefined)) {
    record("rejected", "Invalid or missing X-Hub-Signature-256");
    return { status: 401, message: "Invalid signature" };
  }
  if (event === "ping") {
    record("ok", "ping");
    return { status: 200, message: "pong" };
  }
  if (event !== "push") {
    record("ignored", `event ${event || "(none)"} is not handled`);
    return { status: 202, message: "Event ignored" };
  }
  const ref = String(body?.ref ?? "");
  const branch = ref.replace(/^refs\/heads\//, "");
  if (repo.default_branch && branch !== repo.default_branch) {
    record("ignored", `push to ${branch || ref} (tracking ${repo.default_branch})`);
    return { status: 202, message: "Push to a non-tracked branch ignored" };
  }
  const busy = activeJobFor(repoId);
  if (busy) {
    record("deduplicated", "analysis already queued or running", busy.id);
    return { status: 202, message: "Analysis already in progress", jobId: busy.id };
  }
  const jobId = enqueue("repo.import", repo.workspace_id, { repositoryId: repoId, kinds: PRESET_KINDS[repo.watch_preset] ?? PRESET_KINDS.quick, refresh: true, trigger: "webhook" });
  record("queued", `push ${String(body?.after ?? "").slice(0, 12)} to ${branch}`, jobId);
  audit({ workspaceId: repo.workspace_id, actorType: "system", action: "repository.webhook_push", entityType: "repository", entityId: repoId, data: { branch, after: body?.after ?? null } });
  return { status: 202, message: "Analysis queued", jobId };
}

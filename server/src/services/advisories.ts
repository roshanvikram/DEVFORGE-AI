import { db, json } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { config } from "../config.js";
import { publish } from "../lib/events.js";
import { notify, audit } from "../lib/audit.js";
import { log } from "../lib/logger.js";
import { enqueue, registerHandler, runInline, type JobCtx } from "../jobs/queue.js";
import { getSettings } from "./integrations.js";

/**
 * Advisory watch: new vulnerabilities are published for packages every day, so a repository that has not
 * changed can still become vulnerable. This re-runs the real dependency scan (OSV.dev) for the current
 * snapshot on a schedule and reports exactly which advisories appeared or disappeared since the last check.
 */

function advisoryIds(repositoryId: string): Set<string> {
  const r = db().prepare(`SELECT current_snapshot_id FROM repositories WHERE id = ?`).get(repositoryId) as any;
  const ids = new Set<string>();
  if (!r?.current_snapshot_id) return ids;
  for (const d of db().prepare(`SELECT name, vulns FROM dependencies WHERE snapshot_id = ?`).all(r.current_snapshot_id) as any[]) {
    for (const v of json<any[]>(d.vulns, [])) ids.add(`${v.id}|${d.name}`);
  }
  return ids;
}

async function checkJob(ctx: JobCtx) {
  const { repositoryId, trigger = "schedule" } = ctx.payload as { repositoryId: string; trigger?: string };
  const repo = db().prepare(`SELECT id, name, workspace_id, current_snapshot_id FROM repositories WHERE id = ?`).get(repositoryId) as any;
  if (!repo?.current_snapshot_id) throw new Error("Repository has not been indexed yet");
  const id = newId("adv_");
  const record = (status: string, extra: { packages?: number; advisories?: number; added?: string[]; removed?: string[]; note?: string }) => {
    db().prepare(`INSERT INTO advisory_checks (id, workspace_id, repository_id, status, trigger, packages, advisories, new_advisories, resolved_advisories, note) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, repo.workspace_id, repo.id, status, trigger, extra.packages ?? 0, extra.advisories ?? 0, JSON.stringify(extra.added ?? []), JSON.stringify(extra.removed ?? []), extra.note ?? null);
    publish(repo.workspace_id, { type: "advisory", repositoryId: repo.id, status, added: extra.added?.length ?? 0, removed: extra.removed?.length ?? 0 });
  };
  if (!config.osvEnabled) {
    record("skipped", { note: "OSV lookups are disabled on this server (OSV_ENABLED=false)." });
    return { status: "skipped" };
  }
  const before = advisoryIds(repo.id);
  ctx.progress(0.1, "Re-checking dependencies against OSV.dev");
  const res: any = await runInline("repo.analyze", ctx, { repositoryId: repo.id, kinds: ["dependency"] });
  const scan = res?.scans?.[0];
  if (scan?.error) {
    record("failed", { note: scan.error });
    throw new Error(scan.error);
  }
  const after = advisoryIds(repo.id);
  const added = [...after].filter((x) => !before.has(x));
  const removed = [...before].filter((x) => !after.has(x));
  const packages = (db().prepare(`SELECT COUNT(*) AS n FROM dependencies WHERE snapshot_id = ?`).get(repo.current_snapshot_id) as any).n;
  const osvStatus = db().prepare(`SELECT tools FROM scans WHERE id = ?`).get(scan?.id ?? "") as any;
  const osv = json<any>(osvStatus?.tools, {})?.osv;
  if (osv && osv.status !== "ok") {
    record("failed", { packages, advisories: after.size, note: osv.note ?? "OSV lookup did not complete" });
    return { status: "failed", note: osv.note };
  }
  record("ok", { packages, advisories: after.size, added, removed });
  if (added.length) {
    notify({ workspaceId: repo.workspace_id, kind: "advisory", title: `New vulnerability advisories for ${repo.name}`, body: added.slice(0, 5).map((a) => a.replace("|", " in ")).join(", ") + (added.length > 5 ? ` and ${added.length - 5} more` : ""), link: `/app/dependencies?repo=${repo.id}` });
    audit({ workspaceId: repo.workspace_id, actorType: "system", action: "advisories.new", entityType: "repository", entityId: repo.id, data: { added } });
  }
  return { status: "ok", added: added.length, removed: removed.length, advisories: after.size };
}

registerHandler("advisory.check", checkJob);

export function enqueueAdvisoryCheck(workspaceId: string, repositoryId: string, trigger: string, userId: string | null = null) {
  const busy = db().prepare(`SELECT id FROM jobs WHERE status IN ('queued','running') AND type IN ('advisory.check','repo.import','repo.analyze') AND json_extract(payload, '$.repositoryId') = ? LIMIT 1`).get(repositoryId) as any;
  if (busy) return { jobId: busy.id, deduplicated: true };
  return { jobId: enqueue("advisory.check", workspaceId, { repositoryId, trigger }, { userId }), deduplicated: false };
}

export function advisoryHistory(repositoryId: string, limit = 20) {
  return (db().prepare(`SELECT id, status, trigger, packages, advisories, new_advisories, resolved_advisories, note, created_at FROM advisory_checks WHERE repository_id = ? ORDER BY created_at DESC LIMIT ?`).all(repositoryId, limit) as any[])
    .map((r) => ({ ...r, new_advisories: json(r.new_advisories, []), resolved_advisories: json(r.resolved_advisories, []) }));
}

let timer: NodeJS.Timeout | null = null;
/** Schedules re-checks for repositories whose dependency data is older than ADVISORY_WATCH_HOURS (default 12). */
export function startAdvisoryWatch(intervalMs = 10 * 60_000) {
  if (timer) return;
  const hours = Number(process.env.ADVISORY_WATCH_HOURS ?? 12);
  timer = setInterval(() => {
    try {
      if (!config.osvEnabled) return;
      const due = db()
        .prepare(
          `SELECT r.id, r.workspace_id FROM repositories r
           WHERE r.status = 'ready' AND r.current_snapshot_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM dependencies d WHERE d.snapshot_id = r.current_snapshot_id)
             AND COALESCE((SELECT MAX(created_at) FROM advisory_checks a WHERE a.repository_id = r.id), r.last_analyzed_at, '') <= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
           LIMIT 2`,
        )
        .all(`-${hours} hours`) as { id: string; workspace_id: string }[];
      for (const r of due) {
        if ((getSettings(r.workspace_id).analysis as any).advisoryWatch === false) continue;
        enqueueAdvisoryCheck(r.workspace_id, r.id, "schedule");
      }
    } catch (e: any) {
      log.warn("advisory watch tick failed", { error: String(e?.message ?? e) });
    }
  }, intervalMs);
  timer.unref();
}

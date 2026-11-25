import { db, now } from "../db/db.js";
import { newId, sha256 } from "../lib/ids.js";
import type { RawFinding, FindingSource } from "../engine/types.js";

export function fingerprint(f: RawFinding): string {
  const anchor = (f.snippet ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2).join("|") || String(f.line ?? "");
  return sha256([f.rule_id, f.file_path ?? "", f.title, anchor].join("\u0001")).slice(0, 32);
}

/**
 * Upserts findings for a scan. Findings of the covered sources that were open but not seen
 * in this scan are marked resolved ("no longer detected"), with a history event.
 */
export function persistFindings(params: {
  workspaceId: string;
  repositoryId: string;
  scanId?: string | null;
  reviewId?: string | null;
  findings: RawFinding[];
  coveredSources?: FindingSource[];
  coveredTools?: string[];
}) {
  const d = db();
  const t = now();
  const seen = new Set<string>();
  let created = 0;
  let updated = 0;
  let autoResolved = 0;
  const sel = d.prepare(`SELECT id, status FROM findings WHERE repository_id = ? AND COALESCE(review_id,'') = ? AND fingerprint = ?`);
  const ins = d.prepare(`INSERT INTO findings (id, workspace_id, repository_id, scan_id, review_id, fingerprint, source, origin, tool, rule_id, title, category, severity, confidence, file_path, line, end_line, snippet, evidence, explanation, impact, recommendation, suggested_patch, related, verification)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const upd = d.prepare(`UPDATE findings SET scan_id = ?, last_seen_at = ?, line = ?, end_line = ?, snippet = ?, evidence = ?, severity = ?, confidence = ?, updated_at = ?,
      status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END, resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END WHERE id = ?`);
  const ev = d.prepare(`INSERT INTO finding_events (finding_id, actor_id, kind, data) VALUES (?,?,?,?)`);

  d.transaction(() => {
    for (const f of params.findings) {
      const fp = fingerprint(f);
      if (seen.has(fp)) continue;
      seen.add(fp);
      const existing = sel.get(params.repositoryId, params.reviewId ?? "", fp) as { id: string; status: string } | undefined;
      if (existing) {
        upd.run(params.scanId ?? null, t, f.line ?? null, f.end_line ?? null, f.snippet ?? null, f.evidence, f.severity, f.confidence, t, existing.id);
        if (existing.status === "resolved") ev.run(existing.id, null, "reopened", JSON.stringify({ reason: "Detected again", scanId: params.scanId }));
        updated++;
      } else {
        const id = newId("fnd_");
        ins.run(id, params.workspaceId, params.repositoryId, params.scanId ?? null, params.reviewId ?? null, fp, f.source, f.origin ?? "detected", f.tool, f.rule_id, f.title.slice(0, 300), f.category, f.severity, f.confidence,
          f.file_path ?? null, f.line ?? null, f.end_line ?? null, f.snippet ?? null, f.evidence, f.explanation, f.impact, f.recommendation, f.suggested_patch ?? null, JSON.stringify(f.related ?? []), f.verification);
        ev.run(id, null, "detected", JSON.stringify({ scanId: params.scanId, tool: f.tool }));
        created++;
      }
    }
    if (params.coveredSources?.length && !params.reviewId) {
      const placeholders = params.coveredSources.map(() => "?").join(",");
      const toolFilter = params.coveredTools?.length ? ` AND tool IN (${params.coveredTools.map(() => "?").join(",")})` : "";
      const open = d
        .prepare(`SELECT id, fingerprint FROM findings WHERE repository_id = ? AND review_id IS NULL AND source IN (${placeholders}) AND status IN ('open','triaged','in_progress') AND origin = 'detected'${toolFilter}`)
        .all(params.repositoryId, ...params.coveredSources, ...(params.coveredTools ?? [])) as { id: string; fingerprint: string }[];
      for (const o of open) {
        if (seen.has(o.fingerprint)) continue;
        d.prepare(`UPDATE findings SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?`).run(t, t, o.id);
        ev.run(o.id, null, "auto_resolved", JSON.stringify({ reason: "No longer detected", scanId: params.scanId }));
        autoResolved++;
      }
    }
  })();
  return { created, updated, autoResolved, total: seen.size };
}

export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

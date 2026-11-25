import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ShieldAlert, RefreshCw, Radar, ShieldCheck } from "lucide-react";
import { get, post, put } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useEvent } from "../lib/realtime";
import { Panel, Button, Badge, Toggle, Notice, LoadingBlock, cx } from "./ui";
import { JobPanel } from "./jobs";
import { timeAgo } from "../lib/format";

/** Live advisory watch: scheduled OSV re-checks of an unchanged repository's dependencies. */
export function AdvisoryWatch({ repo }: { repo: any }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["advisories", repo.id], queryFn: () => get<any>(`/repositories/${repo.id}/advisories`) });
  const [jobId, setJobId] = useState<string | null>(null);
  useEvent((e: any) => {
    if (e.type === "advisory" && e.repositoryId === repo.id) {
      qc.invalidateQueries({ queryKey: ["advisories", repo.id] });
      qc.invalidateQueries({ queryKey: ["deps", repo.id] });
    }
  }, [repo.id]);
  const check = async () => {
    try {
      const r = await post<{ jobId: string; deduplicated: boolean }>(`/repositories/${repo.id}/advisories/check`);
      setJobId(r.jobId);
      if (r.deduplicated) toast("A scan is already running for this repository");
    } catch (e: any) { toast.error(e.message); }
  };
  const toggle = async (enabled: boolean) => {
    try {
      await put("/advisory-watch", { enabled });
      qc.invalidateQueries({ queryKey: ["advisories"] });
    } catch (e: any) { toast.error(e.message); }
  };
  const d = q.data;
  const last = d?.history?.[0];
  return (
    <Panel className="aurora-ring mb-4" title={<span className="flex items-center gap-2"><Radar className="size-4 text-iris" />Live advisory watch</span>}
      subtitle="New vulnerabilities are published daily — DevForge re-checks your unchanged dependencies against OSV.dev and alerts you the moment one appears"
      actions={can("analysis.run") && <Button size="sm" variant="aurora" icon={<RefreshCw className="size-3.5" />} onClick={check} disabled={!d?.osvEnabled}>Check now</Button>}>
      {q.isLoading || !d ? <LoadingBlock rows={2} /> : (
        <div className="space-y-3">
          {!d.osvEnabled && <Notice tone="amber">OSV lookups are disabled on this server (OSV_ENABLED=false), so advisory checks cannot run.</Notice>}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[12.5px]">
            <Toggle checked={d.enabled} disabled={!can("settings.manage")} onChange={toggle} label={`Re-check every ${d.intervalHours} h`} />
            <span className="text-muted">{d.packages} packages · <b className={d.vulnerablePackages ? "text-danger" : "text-success"}>{d.vulnerablePackages} vulnerable</b></span>
            <span className="text-muted">Last check: {last ? `${timeAgo(last.created_at)} (${last.trigger})` : "never"}</span>
          </div>
          {jobId && <JobPanel jobId={jobId} compact onFinished={() => qc.invalidateQueries({ queryKey: ["advisories", repo.id] })} />}
          {d.history.length > 0 && (
            <ul className="divide-y divide-line-2 rounded-xl ring-1 ring-line">
              {d.history.slice(0, 5).map((h: any) => (
                <li key={h.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12.5px]">
                  <Badge tone={h.status === "ok" ? (h.new_advisories.length ? "danger" : "success") : h.status === "failed" ? "amber" : "neutral"}>{h.status === "ok" ? (h.new_advisories.length ? "new advisories" : "no change") : h.status}</Badge>
                  {h.new_advisories.map((a: string) => <span key={a} className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 font-mono text-[11px] text-danger"><ShieldAlert className="size-3" />{a.replace("|", " · ")}</span>)}
                  {h.resolved_advisories.map((a: string) => <span key={a} className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 font-mono text-[11px] text-success"><ShieldCheck className="size-3" />{a.replace("|", " · ")} cleared</span>)}
                  {h.note && <span className={cx("text-muted", h.status === "failed" && "text-amber-deep")}>{h.note}</span>}
                  <span className="ml-auto text-[11px] text-faint">{h.advisories} known · {timeAgo(h.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

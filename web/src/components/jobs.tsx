import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Play, X, RotateCcw, ChevronDown } from "lucide-react";
import { get, post } from "../lib/api";
import { Button, ProgressBar, StatusBadge, cx } from "./ui";
import { titleCase } from "../lib/format";

/** Live job panel: progress, message, logs, cancel / retry. Polls until the job is terminal. */
export function JobPanel({ jobId, onFinished, compact }: { jobId: string; onFinished?: (status: string) => void; compact?: boolean }) {
  const qc = useQueryClient();
  const [showLogs, setShowLogs] = useState(!compact);
  const q = useQuery({
    queryKey: ["job", jobId],
    queryFn: async () => {
      const j = await get(`/jobs/${jobId}`);
      if (["completed", "failed", "cancelled"].includes(j.status)) onFinished?.(j.status);
      return j;
    },
    refetchInterval: (qq) => (["completed", "failed", "cancelled"].includes((qq.state.data as any)?.status) ? false : 1000),
  });
  const j = q.data;
  if (!j) return <div className="skeleton h-16" />;
  const active = j.status === "queued" || j.status === "running";
  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <div className="flex items-center gap-3">
        <StatusBadge status={j.status} />
        <span className="text-[13px] font-medium text-ink">{titleCase(j.type.replace(".", " "))}</span>
        <span className="truncate text-[12.5px] text-muted">{j.message}</span>
        <div className="ml-auto flex gap-1.5">
          {active && <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={async () => { await post(`/jobs/${jobId}/cancel`); qc.invalidateQueries({ queryKey: ["job", jobId] }); }}>Cancel</Button>}
          {(j.status === "failed" || j.status === "cancelled") && <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={async () => { await post(`/jobs/${jobId}/retry`); toast("Retry queued"); qc.invalidateQueries(); }}>Retry</Button>}
          <button className="rounded-lg p-1 text-muted hover:bg-ivory" onClick={() => setShowLogs(!showLogs)} aria-label="Toggle logs"><ChevronDown className={cx("size-4 transition", showLogs && "rotate-180")} /></button>
        </div>
      </div>
      {active && <ProgressBar value={j.progress} className="mt-3" />}
      {j.error && <div className="mt-2 text-[12.5px] text-danger">{j.error}</div>}
      {showLogs && (
        <div className="scroll-thin mt-3 max-h-52 overflow-y-auto rounded-lg bg-[#FCFBF8] p-3 font-mono text-[11.5px] leading-relaxed text-ink-2 ring-1 ring-line">
          {j.logs.length ? j.logs.map((l: any, i: number) => <div key={i} className={l.level === "error" ? "text-danger" : l.level === "warn" ? "text-amber-deep" : ""}>{l.message}</div>) : <div className="text-faint">Waiting for output…</div>}
        </div>
      )}
    </div>
  );
}

export function useActiveJobs(filter?: (j: any) => boolean) {
  const q = useQuery({ queryKey: ["jobs", "active"], queryFn: () => get("/jobs?status=queued,running"), refetchInterval: 4000 });
  return (q.data ?? []).filter((j: any) => (filter ? filter(j) : true));
}

export { Play };

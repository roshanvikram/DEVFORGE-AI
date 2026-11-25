import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Radio, Pause, Play, Cpu, Database, Users, Zap, Timer, Activity as ActivityIcon } from "lucide-react";
import { get } from "../../lib/api";
import { useEvent, useRealtime } from "../../lib/realtime";
import { useAuth } from "../../lib/auth";
import { PageHeader, Panel, Stat, Badge, EmptyState, ErrorState, LoadingBlock, Table, Select, Button, cx } from "../../components/ui";
import { JobPanel } from "../../components/jobs";
import { duration, num, timeAgo, titleCase } from "../../lib/format";

type Ev = { type: string; at: string; [k: string]: any };
const TONE: Record<string, "amber" | "success" | "danger" | "info" | "neutral" | "dark"> = { job: "info", scan: "amber", health: "success", gate: "dark", watch: "info", webhook: "info", notification: "amber", activity: "neutral", presence: "neutral" };

function describe(e: Ev): string {
  switch (e.type) {
    case "job": return `${e.jobType ?? "job"} ${e.status}${e.progress != null && e.status === "running" ? ` · ${Math.round(e.progress * 100)}%` : ""}${e.message ? ` — ${e.message}` : ""}`;
    case "job.log": return e.message;
    case "scan": return `${e.kind} scan ${e.status}`;
    case "health": return `Health score ${e.score}${e.delta != null ? ` (${e.delta >= 0 ? "+" : ""}${e.delta})` : ""}`;
    case "gate": return e.passed ? "Quality gate passed" : `Quality gate failed: ${(e.failed ?? []).join(", ")}`;
    case "watch": return `Remote check: ${e.status}${e.remoteSha ? ` @ ${String(e.remoteSha).slice(0, 8)}` : ""}${e.error ? ` — ${e.error}` : ""}`;
    case "webhook": return `Webhook ${e.event || ""} ${e.status}`;
    case "repository": return `Repository ${e.status ?? "updated"}`;
    case "presence": return `${(e.users ?? []).length} online`;
    case "notification": return e.title;
    case "activity": return titleCase(String(e.action ?? "").replace(/\./g, " "));
    default: return titleCase(e.type);
  }
}

export default function LivePage() {
  const { workspace } = useAuth();
  const { connected, presence } = useRealtime();
  const [events, setEvents] = useState<Ev[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("all");
  const q = useQuery({ queryKey: ["live", workspace?.id], queryFn: () => get<any>("/system/live"), refetchInterval: 3000 });
  useEvent((e: Ev) => {
    if (e.type === "hello" || paused) return;
    setEvents((prev) => [{ ...e, at: e.at ?? new Date().toISOString() }, ...prev].slice(0, 150));
  }, [paused]);
  const shown = events.filter((e) => filter === "all" || e.type === filter || (filter === "job" && e.type.startsWith("job")));
  const d = q.data;
  const byStatus = Object.fromEntries((d?.jobs.byStatus ?? []).map((r: any) => [r.status, r.n]));
  const lagTone = d && d.process.eventLoopLagMs.p99 > 100 ? "danger" : d && d.process.eventLoopLagMs.p99 > 40 ? "amber" : "success";

  return (
    <>
      <PageHeader eyebrow="Live" title={<span className="flex items-center gap-3">Live Ops <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold", connected ? "bg-success/10 text-success" : "bg-ivory text-muted")}><span className={cx("relative size-1.5 rounded-full", connected ? "bg-success" : "bg-silver")}>{connected && <span className="absolute inset-0 animate-ping rounded-full bg-success" />}</span>{connected ? "STREAMING" : "OFFLINE"}</span></span>}
        description="Real-time view of this workspace: job queue, analysis throughput, server health and every event as it happens. All values are measured, refreshed every 3 seconds." />
      {q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : !d ? <LoadingBlock /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
            <Stat label="Online now" value={presence.length} icon={<Users className="size-4" />} sub={`${d.realtime.connections} live connection${d.realtime.connections === 1 ? "" : "s"}`} tone="success" />
            <Stat label="Events / min" value={num(d.realtime.eventsPerMinute)} icon={<Zap className="size-4" />} sub={`${num(d.realtime.eventsPublished)} since start`} tone="amber" />
            <Stat label="Workers busy" value={`${d.worker.running}/${d.worker.concurrency}`} icon={<Cpu className="size-4" />} sub={`${byStatus.queued ?? 0} queued`} tone={d.worker.running ? "info" : undefined} />
            <Stat label="Jobs (24h)" value={num((byStatus.completed ?? 0) + (byStatus.failed ?? 0))} icon={<ActivityIcon className="size-4" />} sub={`${byStatus.completed ?? 0} ok · ${byStatus.failed ?? 0} failed`} tone={byStatus.failed ? "danger" : "success"} />
            <Stat label="Event-loop lag p99" value={`${d.process.eventLoopLagMs.p99} ms`} icon={<Timer className="size-4" />} sub={`mean ${d.process.eventLoopLagMs.mean} ms`} tone={lagTone} />
            <Stat label="Memory (RSS)" value={`${d.process.rssMb} MB`} icon={<Cpu className="size-4" />} sub={`heap ${d.process.heapUsedMb} MB · ${d.process.node}`} />
            <Stat label="Database" value={`${(d.database.bytes / 1048576).toFixed(1)} MB`} icon={<Database className="size-4" />} sub={`up ${duration(d.process.uptimeSec * 1000)}`} />
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_420px]">
            <div className="space-y-4">
              <Panel title="Active jobs" subtitle="Queued and running work with live progress">
                {d.jobs.active.length ? <div className="space-y-2">{d.jobs.active.map((j: any) => <JobPanel key={j.id} jobId={j.id} compact />)}</div> : <EmptyState icon={<Cpu className="size-5" />} title="Queue is idle" description="Jobs appear here the moment they are queued." />}
              </Panel>
              <div className="grid gap-4 lg:grid-cols-2">
                <Panel title="Throughput" subtitle="Finished jobs per hour, last 12 hours">
                  {d.jobs.throughput.length ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={d.jobs.throughput.map((t: any) => ({ ...t, hour: t.hour.slice(11) + ":00" }))} margin={{ left: -24, right: 4, top: 6 }}>
                        <CartesianGrid stroke="#EFECE5" vertical={false} />
                        <XAxis dataKey="hour" tick={{ fontSize: 11, fill: "#A3A199" }} tickLine={false} axisLine={false} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#A3A199" }} tickLine={false} axisLine={false} />
                        <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #E7E3DA", fontSize: 12 }} />
                        <Bar dataKey="completed" stackId="a" fill="#23966A" radius={[0, 0, 0, 0]} />
                        <Bar dataKey="failed" stackId="a" fill="#D94C4C" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : <EmptyState title="No finished jobs in 12 hours" />}
                </Panel>
                <Panel title="Job latency" subtitle="Completed jobs, last 7 days" pad={false}>
                  {d.jobs.durations.length ? (
                    <Table head={["Type", "Runs", "Avg", "Max"]}>
                      {d.jobs.durations.map((r: any) => (
                        <tr key={r.type} className="border-b border-line/60 last:border-0"><td className="px-4 py-2 font-mono text-[12px]">{r.type}</td><td className="px-4 py-2 tabular-nums">{r.n}</td><td className="px-4 py-2 tabular-nums">{duration(r.avgMs)}</td><td className="px-4 py-2 tabular-nums text-muted">{duration(r.maxMs)}</td></tr>
                      ))}
                    </Table>
                  ) : <div className="p-5"><EmptyState title="No completed jobs yet" /></div>}
                </Panel>
              </div>
              <Panel title="Online teammates" subtitle="Who is in this workspace right now">
                {presence.length ? (
                  <div className="flex flex-wrap gap-2">
                    {presence.map((u) => (
                      <div key={u.userId} className="flex items-center gap-2 rounded-xl bg-white/70 px-3 py-2 ring-1 ring-line">
                        <span className="relative grid size-7 place-items-center rounded-full bg-ivory text-[11px] font-semibold">{u.name.slice(0, 1).toUpperCase()}<span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-success ring-2 ring-white" /></span>
                        <div className="text-[12px] leading-tight"><div className="font-medium text-ink">{u.name}</div><div className="font-mono text-[11px] text-muted">{u.path} · active {timeAgo(u.lastActive)}</div></div>
                      </div>
                    ))}
                  </div>
                ) : <EmptyState title="Nobody connected" description="Presence appears when the live connection is open." />}
              </Panel>
            </div>

            <Panel title={<span className="flex items-center gap-2"><Radio className="size-4 text-amber" />Event stream</span>} subtitle={`${shown.length} events captured since you opened this page`} pad={false}
              actions={<div className="flex items-center gap-2"><Select value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8 w-32 text-[12px]">{["all", "job", "scan", "health", "gate", "watch", "webhook", "activity", "notification", "presence"].map((f) => <option key={f} value={f}>{titleCase(f)}</option>)}</Select><Button size="sm" variant="ghost" icon={paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />} onClick={() => setPaused(!paused)}>{paused ? "Resume" : "Pause"}</Button></div>}>
              <div className="scroll-thin max-h-[720px] overflow-y-auto">
                {shown.length ? (
                  <ul>
                    <AnimatePresence initial={false}>
                      {shown.map((e, i) => (
                        <motion.li key={`${e.at}-${i}-${e.type}`} layout initial={{ opacity: 0, y: -8, backgroundColor: "rgba(217,154,40,0.12)" }} animate={{ opacity: 1, y: 0, backgroundColor: "rgba(0,0,0,0)" }} transition={{ duration: 0.5 }} className="flex items-start gap-2.5 border-b border-line/60 px-4 py-2 text-[12.5px]">
                          <span className="mt-0.5 w-[62px] shrink-0 font-mono text-[11px] text-faint">{new Date(e.at).toLocaleTimeString()}</span>
                          <Badge tone={TONE[e.type.split(".")[0]] ?? "neutral"} className="shrink-0">{e.type}</Badge>
                          <span className="min-w-0 break-words text-ink-2">{describe(e)}</span>
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </ul>
                ) : <div className="p-6"><EmptyState icon={<Radio className="size-5" />} title={paused ? "Stream paused" : "Listening…"} description="Run an analysis or open another tab to see events arrive instantly." /></div>}
              </div>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}

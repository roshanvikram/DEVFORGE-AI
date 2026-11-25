import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { BarChart3 } from "lucide-react";
import { get } from "../../lib/api";
import { useRepo } from "../../lib/repo";
import { PageHeader, Panel, Select, Stat, EmptyState, LoadingBlock, ErrorState, Table } from "../../components/ui";
import { SEVERITIES, SEV_COLOR, titleCase, usd, num } from "../../lib/format";

const tt = { contentStyle: { borderRadius: 10, border: "1px solid #E7E3DA", fontSize: 12 } };
const axis = { tick: { fontSize: 11, fill: "#A3A199" }, axisLine: false, tickLine: false } as const;
const SRC_COLORS: Record<string, string> = { bug: "#D99A28", security: "#D94C4C", secret: "#B4232C", dependency: "#8A6FA0", performance: "#3B6EA8", debt: "#6B7F96" };

export default function Analytics() {
  const { repos } = useRepo();
  const [days, setDays] = useState(30);
  const [repo, setRepo] = useState("");
  const q = useQuery({ queryKey: ["analytics", days, repo], queryFn: () => get(`/analytics?days=${days}${repo ? `&repo=${repo}` : ""}`) });
  const d = q.data;
  const opened = useMemo(() => {
    const m = new Map<string, any>();
    for (const r of d?.findingsOpened ?? []) { const x = m.get(r.day) ?? { day: r.day }; x[r.source] = r.n; m.set(r.day, x); }
    for (const r of d?.findingsResolved ?? []) { const x = m.get(r.day) ?? { day: r.day }; x.resolved = r.n; m.set(r.day, x); }
    return [...m.values()].sort((a, b) => a.day.localeCompare(b.day));
  }, [d]);
  const matrix = useMemo(() => { const m: Record<string, Record<string, number>> = {}; for (const r of d?.riskMatrix ?? []) (m[r.severity] ??= {})[r.confidence] = r.n; return m; }, [d]);
  const agentRows = useMemo(() => { const m = new Map<string, any>(); for (const r of d?.agents ?? []) { const x = m.get(r.agent_key) ?? { agent: titleCase(r.agent_key), completed: 0, failed: 0, other: 0, cost: 0, tokens: 0 }; if (r.status === "completed") x.completed += r.n; else if (r.status === "failed") x.failed += r.n; else x.other += r.n; x.cost += r.cost ?? 0; x.tokens += r.tokens ?? 0; m.set(r.agent_key, x); } return [...m.values()]; }, [d]);
  const openTotal = (d?.openBySeverity ?? []).reduce((a: number, r: any) => a + r.n, 0);
  const resolvedTotal = (d?.resolution ?? []).reduce((a: number, r: any) => a + r.n, 0);
  const scanCount = (d?.scans ?? []).reduce((a: number, r: any) => a + r.n, 0);
  const aiCost = (d?.ai ?? []).reduce((a: number, r: any) => a + (r.cost ?? 0), 0);
  const empty = !opened.length && !scanCount && !agentRows.length;
  return (
    <>
      <PageHeader eyebrow="Engineering Analytics" icon={<BarChart3 className="size-6 text-amber-deep" />} title="Analytics" description="Every metric is derived from recorded scans, findings, test runs, reviews, agent runs and AI usage in this workspace."
        actions={<><Select value={repo} onChange={(e) => setRepo(e.target.value)}><option value="">All repositories</option>{repos?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select><Select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></Select></>} />
      {q.isLoading ? <LoadingBlock rows={8} /> : q.error ? <ErrorState error={q.error} /> : empty ? <Panel><EmptyState title="No activity recorded in this period" description="Analytics populate as you run scans, tests, reviews and agents." /></Panel> : (
        <>
          <div className="mb-4 grid gap-3 md:grid-cols-5">
            <Stat label="Open findings" value={num(openTotal)} />
            <Stat label="Resolved (all time)" value={num(resolvedTotal)} tone="success" />
            <Stat label={`Scans (${days}d)`} value={num(scanCount)} />
            <Stat label={`Agent runs (${days}d)`} value={num(agentRows.reduce((a, r) => a + r.completed + r.failed + r.other, 0))} />
            <Stat label={`AI spend (${days}d)`} value={usd(aiCost)} sub="from provider-reported usage" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Findings opened by analyzer vs resolved">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={opened} margin={{ left: -20 }}><CartesianGrid stroke="#EFECE5" vertical={false} /><XAxis dataKey="day" {...axis} /><YAxis {...axis} allowDecimals={false} /><Tooltip {...tt} cursor={{ fill: "#F7F6F2" }} /><Legend wrapperStyle={{ fontSize: 11 }} />
                  {Object.keys(SRC_COLORS).map((s) => <Bar key={s} dataKey={s} stackId="o" fill={SRC_COLORS[s]} />)}
                  <Bar dataKey="resolved" fill="#23966A" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Panel>
            <Panel title="Risk matrix" subtitle="Open findings by severity × confidence">
              <table className="w-full text-center text-[12.5px]">
                <thead><tr><th /><th className="py-2 font-medium text-muted">high conf.</th><th className="font-medium text-muted">medium</th><th className="font-medium text-muted">low</th></tr></thead>
                <tbody>{SEVERITIES.map((s) => <tr key={s}><td className="py-1.5 pr-2 text-left capitalize text-ink-2">{s}</td>{["high", "medium", "low"].map((c) => { const n = matrix[s]?.[c] ?? 0; return <td key={c} className="p-1"><div className="rounded-lg py-2 font-semibold tabular-nums" style={{ background: n ? `${SEV_COLOR[s]}${Math.min(99, 15 + n * 6).toString(16).padStart(2, "0")}` : "#F7F6F2", color: n > 6 ? "white" : "#242521" }}>{n}</div></td>; })}</tr>)}</tbody>
              </table>
            </Panel>
            <Panel title="Test outcomes">
              {d.tests.length ? <ResponsiveContainer width="100%" height={220}><AreaChart data={d.tests} margin={{ left: -20 }}><CartesianGrid stroke="#EFECE5" vertical={false} /><XAxis dataKey="day" {...axis} /><YAxis {...axis} allowDecimals={false} /><Tooltip {...tt} /><Area dataKey="passed" stackId="t" stroke="#23966A" fill="#23966A33" /><Area dataKey="failed" stackId="t" stroke="#D94C4C" fill="#D94C4C33" /></AreaChart></ResponsiveContainer> : <EmptyState title="No executed tests" />}
            </Panel>
            <Panel title="Code review risk">
              {d.reviews.length ? <ResponsiveContainer width="100%" height={220}><LineChart data={d.reviews} margin={{ left: -20 }}><CartesianGrid stroke="#EFECE5" vertical={false} /><XAxis dataKey="day" {...axis} /><YAxis {...axis} domain={[0, 100]} /><Tooltip {...tt} /><Line dataKey="risk" stroke="#D99A28" strokeWidth={2} dot={{ r: 3 }} name="avg risk" /></LineChart></ResponsiveContainer> : <EmptyState title="No reviews in this period" />}
            </Panel>
            <Panel title="Codebase size over snapshots">
              {d.snapshots.length ? <ResponsiveContainer width="100%" height={220}><LineChart data={d.snapshots.map((s: any) => ({ ...s, t: s.created_at.slice(0, 10) }))} margin={{ left: 0 }}><CartesianGrid stroke="#EFECE5" vertical={false} /><XAxis dataKey="t" {...axis} /><YAxis {...axis} /><Tooltip {...tt} /><Line dataKey="loc" stroke="#6B7F96" strokeWidth={2} name="LOC" /></LineChart></ResponsiveContainer> : <EmptyState title="No snapshots" />}
            </Panel>
            <Panel title="Mean time to resolve" pad={false}>
              {d.resolution.length ? <Table head={["Analyzer", "Resolved", "Avg days"]}>{d.resolution.map((r: any) => <tr key={r.source}><td className="px-4 py-2 capitalize">{r.source}</td><td className="px-4 py-2 tabular-nums">{r.n}</td><td className="px-4 py-2 tabular-nums">{r.avg_days?.toFixed(1)}</td></tr>)}</Table> : <EmptyState title="Nothing resolved yet" />}
            </Panel>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Panel title="Agent performance" pad={false}>
              {agentRows.length ? <Table head={["Agent", "Completed", "Failed", "Success", "Tokens", "Cost"]}>{agentRows.map((r) => <tr key={r.agent}><td className="px-4 py-2">{r.agent}</td><td className="px-4 py-2 tabular-nums text-success">{r.completed}</td><td className="px-4 py-2 tabular-nums text-danger">{r.failed}</td><td className="px-4 py-2 tabular-nums">{Math.round((r.completed / Math.max(1, r.completed + r.failed)) * 100)}%</td><td className="px-4 py-2 tabular-nums">{num(r.tokens)}</td><td className="px-4 py-2 tabular-nums">{usd(r.cost)}</td></tr>)}</Table> : <EmptyState title="No agent runs" />}
            </Panel>
            <Panel title="Analysis duration" pad={false}>
              {d.scans.length ? <Table head={["Scan", "Status", "Runs", "Avg duration"]}>{d.scans.map((r: any, i: number) => <tr key={i}><td className="px-4 py-2 capitalize">{r.kind}</td><td className="px-4 py-2">{r.status}</td><td className="px-4 py-2 tabular-nums">{r.n}</td><td className="px-4 py-2 tabular-nums">{r.avg_sec != null ? `${r.avg_sec.toFixed(1)}s` : "—"}</td></tr>)}</Table> : <EmptyState title="No scans" />}
            </Panel>
            <Panel title="AI usage by feature" pad={false} className="lg:col-span-2">
              {d.ai.length ? <Table head={["Feature", "Requests", "Input tokens", "Output tokens", "Errors", "Cost"]}>{d.ai.map((r: any) => <tr key={r.feature}><td className="px-4 py-2 font-mono text-[12px]">{r.feature}</td><td className="px-4 py-2 tabular-nums">{r.n}</td><td className="px-4 py-2 tabular-nums">{num(r.input)}</td><td className="px-4 py-2 tabular-nums">{num(r.output)}</td><td className="px-4 py-2 tabular-nums">{r.errors}</td><td className="px-4 py-2 tabular-nums">{usd(r.cost)}</td></tr>)}</Table> : <EmptyState title="No AI usage recorded" />}
            </Panel>
          </div>
        </>
      )}
    </>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { Atom, Play, Info, Timer, Target, TrendingUp, ListChecks } from "lucide-react";
import { get, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useEvent } from "../../lib/realtime";
import { NeedsRepo } from "../../components/AppShell";
import { PageHeader, Panel, Button, Field, Input, Stat, Badge, SeverityBadge, Notice, EmptyState, LoadingBlock, Table, cx } from "../../components/ui";
import { titleCase, fmtDate } from "../../lib/format";

type Sample = { sweep: number; gamma: number; bestValue: number; energy: number };
const SOURCES = ["secret", "dependency", "security", "bug", "performance", "debt"] as const;

function OptimizerView({ repo }: { repo: any }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const info = useQuery({ queryKey: ["optimizer", repo.id], queryFn: () => get<any>(`/repositories/${repo.id}/optimizer`) });
  const [budget, setBudget] = useState(8);
  const [effort, setEffort] = useState<Record<string, number> | null>(null);
  const [advanced, setAdvanced] = useState({ sweeps: 600, replicas: 16, seed: 7 });
  const [planId, setPlanId] = useState<string | null>(params.get("plan"));
  const [live, setLive] = useState<Sample[]>([]);
  const [running, setRunning] = useState(false);
  useEffect(() => { if (info.data && !effort) setEffort(info.data.defaultEffort); }, [info.data]);

  const plan = useQuery({ queryKey: ["fix-plan", planId], queryFn: () => get<any>(`/fix-plans/${planId}`), enabled: !!planId });
  useEvent((e: any) => {
    if (e.type !== "quantum" || e.planId !== planId) return;
    if (e.done) {
      setRunning(false);
      qc.invalidateQueries({ queryKey: ["fix-plan", planId] });
      qc.invalidateQueries({ queryKey: ["optimizer", repo.id] });
      if (e.error) toast.error(e.error);
      return;
    }
    setLive((l) => [...l, { sweep: e.sweep, gamma: e.gamma, bestValue: e.bestValue, energy: e.energy }]);
  }, [planId]);

  const runPlan = async () => {
    try {
      setLive([]);
      setRunning(true);
      const r = await post<{ id: string }>(`/repositories/${repo.id}/optimizer`, { budgetHours: budget, effort: effort ?? undefined, ...advanced });
      setPlanId(r.id);
      setParams((p) => { p.set("plan", r.id); return p; }, { replace: true });
    } catch (e: any) {
      setRunning(false);
      toast.error(e.message);
    }
  };

  const res = plan.data?.result;
  const trace: Sample[] = res?.trace ?? live;
  const chosen = res ? res[res.chosen] : null;
  const maxBudget = Math.max(4, Math.ceil(info.data?.totalHours ?? 40));
  const byFile = useMemo(() => new Set((res?.selected ?? []).map((s: any) => s.file)).size, [res]);

  return (
    <>
      <PageHeader eyebrow="Intelligence" icon={<Atom className="size-6 text-iris" />} title={<>Fix <span className="aurora-text">Optimizer</span></>}
        description="Choose the set of fixes that removes the most risk within your time budget. Solved with simulated quantum annealing — a quantum-inspired algorithm running on classical hardware — and checked against a greedy baseline."
        actions={<Badge tone="dark">Quantum-inspired · classical hardware</Badge>} />

      {info.isLoading ? <LoadingBlock /> : !info.data?.candidates ? (
        <Panel><EmptyState icon={<Target className="size-5" />} title="Nothing to optimise" description="There are no open detected findings for this repository. Run an analysis first." /></Panel>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
          <div className="space-y-4">
            <Panel title="Budget & effort model" subtitle={`${info.data.candidates} open findings · ~${info.data.totalHours} h to fix all (estimate)`}>
              <div className="space-y-4">
                <Field label={`Time budget: ${budget} h`}>
                  <input type="range" min={1} max={maxBudget} step={0.5} value={budget} onChange={(e) => setBudget(Number(e.target.value))} className="w-full accent-[var(--color-iris)]" aria-label="Time budget in hours" />
                </Field>
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-2">Estimated hours per fix <span title="Estimates, not measurements — adjust them to your team. Two fixes in the same file share context and cost 25% less of the smaller one."><Info className="size-3.5 text-faint" /></span></div>
                  <div className="grid grid-cols-2 gap-2">
                    {SOURCES.map((s) => (
                      <label key={s} className="flex items-center justify-between gap-2 rounded-lg bg-ivory/60 px-2.5 py-1.5 text-[12px] ring-1 ring-line">
                        <span className="text-ink-2">{titleCase(s)}</span>
                        <input type="number" min={0.1} max={80} step={0.5} value={effort?.[s] ?? ""} onChange={(e) => setEffort({ ...(effort ?? {}), [s]: Number(e.target.value) })} className="w-14 rounded-md bg-white px-1.5 py-0.5 text-right tabular-nums ring-1 ring-line" aria-label={`${s} hours`} />
                      </label>
                    ))}
                  </div>
                </div>
                <details className="text-[12px]">
                  <summary className="cursor-pointer text-muted">Annealing parameters</summary>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <Field label="Sweeps"><Input type="number" min={50} max={5000} value={advanced.sweeps} onChange={(e) => setAdvanced({ ...advanced, sweeps: Number(e.target.value) })} /></Field>
                    <Field label="Replicas"><Input type="number" min={2} max={64} value={advanced.replicas} onChange={(e) => setAdvanced({ ...advanced, replicas: Number(e.target.value) })} /></Field>
                    <Field label="Seed"><Input type="number" min={0} value={advanced.seed} onChange={(e) => setAdvanced({ ...advanced, seed: Number(e.target.value) })} /></Field>
                  </div>
                </details>
                <Button variant="aurora" className="w-full" loading={running} disabled={!can("analysis.run")} icon={<Play className="size-4" />} onClick={runPlan}>Optimise fix plan</Button>
              </div>
            </Panel>
            <Panel title="Recent plans" pad={false}>
              {info.data.plans.length ? (
                <ul>{info.data.plans.map((p: any) => (
                  <li key={p.id}><button onClick={() => { setPlanId(p.id); setLive([]); setParams((q) => { q.set("plan", p.id); return q; }, { replace: true }); }} className={cx("flex w-full items-center gap-2 border-b border-line-2 px-4 py-2.5 text-left text-[12.5px] last:border-0 hover:bg-ivory/60", planId === p.id && "bg-iris-soft/50")}>
                    <Badge tone={p.status === "completed" ? "success" : p.status === "failed" ? "danger" : "info"}>{p.status}</Badge>
                    <span className="text-ink">{p.params.budgetHours} h</span>
                    {p.result && <span className="text-muted">{p.result.selectedCount} fixes · {p.result.chosen === "sqa" ? "annealing" : "greedy"}</span>}
                    <span className="ml-auto text-[11px] text-faint">{fmtDate(p.created_at)}</span>
                  </button></li>
                ))}</ul>
              ) : <div className="p-4 text-[12.5px] text-muted">Plans you run appear here.</div>}
            </Panel>
          </div>

          <div className="min-w-0 space-y-4">
            {(running || res) && (
              <Panel title="Annealing trace" subtitle="Best feasible risk reduction found so far, as the transverse field Γ is lowered">
                {running && <div className="aurora-live mb-3 h-1 rounded-full" />}
                {trace.length ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={trace} margin={{ left: -10, right: 8, top: 6 }}>
                      <CartesianGrid stroke="var(--color-line-2)" vertical={false} />
                      <XAxis dataKey="sweep" tick={{ fontSize: 11, fill: "var(--color-faint)" }} tickLine={false} axisLine={false} />
                      <YAxis yAxisId="v" tick={{ fontSize: 11, fill: "var(--color-faint)" }} tickLine={false} axisLine={false} />
                      <YAxis yAxisId="g" orientation="right" tick={{ fontSize: 11, fill: "var(--color-faint)" }} tickLine={false} axisLine={false} />
                      <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid var(--color-line)", fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Line yAxisId="v" type="monotone" dataKey="bestValue" name="Best risk reduction" stroke="var(--color-iris)" strokeWidth={2.2} dot={false} isAnimationActive={false} />
                      <Line yAxisId="g" type="monotone" dataKey="gamma" name="Transverse field Γ" stroke="var(--color-amber)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : <p className="text-[13px] text-muted">Waiting for the first samples…</p>}
              </Panel>
            )}

            {plan.data?.status === "failed" && <Notice tone="danger">{plan.data.error}</Notice>}
            {res && chosen && (
              <>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Stat label="Fixes selected" value={chosen.count} icon={<ListChecks className="size-4" />} sub={`${byFile} files`} tone="info" />
                  <Stat label="Hours used" value={`${chosen.cost} h`} icon={<Timer className="size-4" />} sub={`of ${res.budgetHours} h budget`} />
                  <Stat label="Risk reduction" value={chosen.value} icon={<Target className="size-4" />} sub="severity × confidence × centrality" tone="success" />
                  <Stat label="vs greedy" value={res.improvementPct == null ? "—" : `${res.improvementPct > 0 ? "+" : ""}${res.improvementPct}%`} icon={<TrendingUp className="size-4" />} sub={`greedy: ${res.greedy.value} in ${res.greedy.cost} h`} tone={res.improvementPct > 0 ? "success" : undefined} />
                </div>
                <Notice tone="info">{res.method}. {res.chosen === "sqa" ? (res.improvementPct > 0 ? `Annealing found a better plan than the greedy baseline (${res.candidates} candidates, ${res.ms} ms).` : `Annealing matched the greedy baseline (${res.candidates} candidates, ${res.ms} ms).`) : "The greedy baseline was better on this run, so it is used."}</Notice>
                <Panel title="Recommended fix order" subtitle="Highest value per hour first" pad={false}>
                  <Table head={["#", "Severity", "Finding", "File", "Value", "Est. h"]}>
                    {[...res.selected].sort((a: any, b: any) => b.value / b.cost - a.value / a.cost).map((s: any, i: number) => (
                      <tr key={s.id} className="border-b border-line-2 last:border-0">
                        <td className="px-4 py-2 text-muted tabular-nums">{i + 1}</td>
                        <td className="px-4 py-2"><SeverityBadge severity={s.severity} /></td>
                        <td className="max-w-[360px] px-4 py-2"><Link to={`/app/findings/${s.id}`} className="line-clamp-1 text-ink hover:text-iris">{s.title}</Link><div className="text-[11px] text-muted">{titleCase(s.source)}</div></td>
                        <td className="px-4 py-2 font-mono text-[11.5px] text-ink-2">{s.file ?? "—"}</td>
                        <td className="px-4 py-2 tabular-nums">{s.value}</td>
                        <td className="px-4 py-2 tabular-nums">{s.cost}</td>
                      </tr>
                    ))}
                  </Table>
                </Panel>
              </>
            )}
            {!running && !res && plan.data?.status !== "failed" && (
              <Panel><EmptyState icon={<Atom className="size-5 text-iris" />} title="Set a budget and optimise" description="The annealer explores combinations of fixes, including shared-file savings, and streams its progress here live." /></Panel>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default function OptimizerPage() {
  return <NeedsRepo>{(repo) => <OptimizerView key={repo.id} repo={repo} />}</NeedsRepo>;
}

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { ArrowDownRight, ArrowUpRight, Minus, BadgeCheck, ShieldAlert } from "lucide-react";
import { get } from "../lib/api";
import { fmtDate } from "../lib/format";
import { HealthRing, Panel, Skeleton, cx } from "./ui";
import { gradeFor, DIMENSIONS } from "../lib/grade";



export function DeltaChip({ delta, className }: { delta: number | null | undefined; className?: string }) {
  if (delta == null) return null;
  const up = delta > 0, flat = delta === 0;
  const I = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cx("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums", flat ? "bg-ivory text-muted" : up ? "bg-success/10 text-success" : "bg-danger/10 text-danger", className)} title="Change since the previous analysis">
      <I className="size-3" />{flat ? "0" : `${up ? "+" : ""}${delta}`}
    </span>
  );
}

/** Repository health: live score, letter grade, weighted dimensions, recorded history and latest gate result. */
export function HealthPanel({ repoId }: { repoId: string }) {
  const q = useQuery({ queryKey: ["health", repoId], queryFn: () => get<any>(`/repositories/${repoId}/health?limit=30`) });
  const gate = useQuery({ queryKey: ["quality-gate", repoId], queryFn: () => get<any>(`/quality-gate?repo=${repoId}`) });
  const cur = q.data?.current;
  const score: number | null = cur?.score ?? null;
  const g = gradeFor(score);
  const history = q.data?.history ?? [];
  const lastGate = gate.data?.gate?.enabled ? gate.data.results?.[0] : null;
  return (
    <Panel className="relative overflow-hidden">
      <div className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full blur-3xl" style={{ background: `${g.color}22` }} />
      {q.isLoading ? (
        <div className="flex flex-col items-center gap-3"><Skeleton className="size-[168px] rounded-full" /><Skeleton className="h-24 w-full" /></div>
      ) : (
        <>
          <div className="flex flex-col items-center">
            <HealthRing score={score} size={168} showGrade />
            <div className="mt-2 flex items-center gap-2 text-[11.5px] text-muted">
              <DeltaChip delta={q.data?.delta} />
              {history.length > 0 && <span>{history.length} recorded analys{history.length === 1 ? "is" : "es"}</span>}
            </div>
          </div>
          <div className="mt-4 space-y-2.5">
            {DIMENSIONS.map((d, i) => {
              const v: number | undefined = cur?.breakdown?.[d.key];
              const c = gradeFor(v ?? null).color;
              return (
                <div key={d.key} title={`${d.label}: derived from open ${d.hint}; weight ${d.weight}%`}>
                  <div className="flex items-baseline justify-between text-[12px]">
                    <span className="text-ink-2">{d.label} <span className="text-faint">· {d.weight}%</span></span>
                    <span className="font-semibold tabular-nums text-ink">{v ?? "—"}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ivory ring-1 ring-line">
                    <motion.div className="h-full rounded-full" style={{ background: `linear-gradient(90deg, ${c}aa, ${c})` }} initial={{ width: 0 }} animate={{ width: `${v ?? 0}%` }} transition={{ duration: 0.9, delay: 0.1 + i * 0.08, ease: "easeOut" }} />
                  </div>
                </div>
              );
            })}
          </div>
          {history.length > 1 && (
            <div className="mt-4">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Score history</div>
              <ResponsiveContainer width="100%" height={64}>
                <AreaChart data={history} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
                  <defs><linearGradient id="hh" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={g.color} stopOpacity={0.35} /><stop offset="1" stopColor={g.color} stopOpacity={0} /></linearGradient></defs>
                  <YAxis domain={[0, 100]} hide />
                  <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #E7E3DA", fontSize: 12 }} labelFormatter={(_, p: any) => fmtDate(p?.[0]?.payload?.created_at)} formatter={(v: any) => [v, "Score"]} />
                  <Area type="monotone" dataKey="score" stroke={g.color} strokeWidth={2} fill="url(#hh)" isAnimationActive />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
          {lastGate ? (
            <Link to={`/app/gates?repo=${repoId}`} className={cx("mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] ring-1", lastGate.passed ? "bg-success/5 text-success ring-success/20" : "bg-danger/5 text-danger ring-danger/20")}>
              {lastGate.passed ? <BadgeCheck className="size-4" /> : <ShieldAlert className="size-4" />}
              Quality gate {lastGate.passed ? "passing" : "failing"}<span className="ml-auto text-[11px] opacity-70">{fmtDate(lastGate.created_at)}</span>
            </Link>
          ) : (
            <Link to="/app/gates" className="mt-3 block text-center text-[11.5px] text-muted hover:text-ink">Set up a quality gate →</Link>
          )}
          <p className="mt-2 text-center text-[11px] leading-relaxed text-faint">Severity-weighted open findings per KLOC. Detected findings only.</p>
        </>
      )}
    </Panel>
  );
}

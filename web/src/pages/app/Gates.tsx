import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BadgeCheck, ShieldAlert, Save, PlayCircle } from "lucide-react";
import { get, put, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useRepo } from "../../lib/repo";
import { PageHeader, Panel, Button, Field, Input, Toggle, Badge, EmptyState, ErrorState, LoadingBlock, Notice, cx } from "../../components/ui";
import { fmtDate, titleCase } from "../../lib/format";

const FIELDS = [
  { key: "min_score", label: "Minimum health score", hint: "0–100. Fails when the score is lower.", max: 100 },
  { key: "max_critical", label: "Max open critical findings", hint: "Fails when there are more." },
  { key: "max_high", label: "Max open high findings", hint: "Fails when there are more." },
  { key: "max_secrets", label: "Max exposed secrets", hint: "0 blocks any detected credential." },
  { key: "max_vulnerable_deps", label: "Max vulnerable dependencies", hint: "From OSV advisories in the latest dependency scan." },
] as const;
type Form = { enabled: boolean } & Record<(typeof FIELDS)[number]["key"], string>;

export default function GatesPage() {
  const { can } = useAuth();
  const { repo } = useRepo();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["quality-gate", "all"], queryFn: () => get<any>("/quality-gate") });
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  useEffect(() => {
    if (!q.data || form) return;
    const g = q.data.gate;
    setForm({ enabled: g?.enabled ?? true, ...Object.fromEntries(FIELDS.map((f) => [f.key, g?.[f.key] != null ? String(g[f.key]) : f.key === "min_score" ? "70" : f.key === "max_critical" || f.key === "max_secrets" ? "0" : ""])) } as Form);
  }, [q.data]);
  const editable = can("settings.manage");
  const toNum = (s: string) => (s.trim() === "" ? null : Number(s));
  const invalid = form ? FIELDS.find((f) => { const n = toNum(form[f.key]); return n != null && (!Number.isInteger(n) || n < 0 || ("max" in f && n > f.max)); }) : null;

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await put("/quality-gate", { enabled: form.enabled, ...Object.fromEntries(FIELDS.map((f) => [f.key, toNum(form[f.key])])) });
      toast.success("Quality gate saved. It runs automatically after every analysis.");
      qc.invalidateQueries({ queryKey: ["quality-gate"] });
    } catch (e: any) { toast.error(e.message); } finally { setSaving(false); }
  };
  const evaluate = async () => {
    if (!repo) return;
    setEvaluating(true);
    try {
      const r = await post<any>("/quality-gate/evaluate", { repositoryId: repo.id });
      toast[r.passed ? "success" : "error"](r.passed ? `${repo.name} passes the gate` : `${repo.name} fails ${r.checks.filter((c: any) => !c.passed).length} check(s)`);
      qc.invalidateQueries({ queryKey: ["quality-gate"] });
    } catch (e: any) { toast.error(e.message); } finally { setEvaluating(false); }
  };

  const results: any[] = q.data?.results ?? [];
  const latest = repo ? results.find((r) => r.repository_id === repo.id) : null;
  return (
    <>
      <PageHeader eyebrow="Live" title="Quality Gates" description="Release policy evaluated automatically after every analysis, auto-sync and webhook push. Members are notified in real time when a repository starts failing or recovers."
        actions={repo && can("analysis.run") && <Button variant="primary" loading={evaluating} disabled={!q.data?.gate?.enabled} icon={<PlayCircle className="size-4" />} onClick={evaluate}>Evaluate {repo.name}</Button>} />
      {q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : !form ? <LoadingBlock /> : (
        <div className="grid gap-4 lg:grid-cols-[400px_1fr]">
          <Panel title="Policy" subtitle="Leave a field empty to skip that check">
            {!editable && <div className="mb-3"><Notice tone="info">Only owners and admins can change the policy.</Notice></div>}
            <div className="space-y-3">
              <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Gate enabled" disabled={!editable} />
              {FIELDS.map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint} error={invalid?.key === f.key ? "Must be a whole number in range" : null}>
                  <Input type="number" min={0} max={"max" in f ? f.max : undefined} value={form[f.key]} disabled={!editable} placeholder="No limit" onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
                </Field>
              ))}
              {editable && <Button variant="primary" className="w-full" loading={saving} disabled={!!invalid} icon={<Save className="size-4" />} onClick={save}>Save policy</Button>}
              {q.data?.gate?.updated_at && <p className="text-center text-[11px] text-faint">Last updated {fmtDate(q.data.gate.updated_at)}</p>}
            </div>
          </Panel>
          <div className="space-y-4">
            {latest && (
              <Panel className={cx("ring-1", latest.passed ? "ring-success/25" : "ring-danger/25")}>
                <div className="flex items-center gap-3">
                  <div className={cx("grid size-12 place-items-center rounded-2xl", latest.passed ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>{latest.passed ? <BadgeCheck className="size-6" /> : <ShieldAlert className="size-6" />}</div>
                  <div><div className="text-[17px] font-semibold text-ink">{latest.repository}: {latest.passed ? "Passing" : "Failing"}</div><div className="text-[12.5px] text-muted">Evaluated {fmtDate(latest.created_at)} · trigger: {latest.trigger}</div></div>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {latest.checks.map((c: any) => (
                    <div key={c.key} className={cx("rounded-xl px-3 py-2.5 ring-1", c.passed ? "bg-success/5 ring-success/20" : "bg-danger/5 ring-danger/20")}>
                      <div className="text-[12px] text-muted">{c.label}</div>
                      <div className="flex items-baseline gap-2"><span className={cx("text-[20px] font-semibold tabular-nums", c.passed ? "text-success" : "text-danger")}>{c.actual ?? "n/a"}</span><span className="text-[12px] text-faint">limit {c.comparator} {c.threshold}</span></div>
                    </div>
                  ))}
                </div>
              </Panel>
            )}
            <Panel title="Evaluation history" subtitle="Every recorded gate result across repositories" pad={false}>
              {results.length ? (
                <ul>
                  {results.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-3 border-b border-line/60 px-5 py-3 text-[13px] last:border-0">
                      <Badge tone={r.passed ? "success" : "danger"}>{r.passed ? "passed" : "failed"}</Badge>
                      <span className="font-medium text-ink">{r.repository}</span>
                      <span className="text-muted">{r.checks.filter((c: any) => !c.passed).map((c: any) => c.label).join(", ") || "all checks passed"}</span>
                      <span className="ml-auto text-[12px] text-faint">{titleCase(r.trigger)} · {fmtDate(r.created_at)}</span>
                    </li>
                  ))}
                </ul>
              ) : <div className="p-6"><EmptyState icon={<BadgeCheck className="size-5" />} title="No evaluations yet" description="Save a policy, then evaluate a repository or run an analysis." /></div>}
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}

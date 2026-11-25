import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ShieldCheck, KeyRound, Boxes, History, ScanSearch, FileText, ListOrdered } from "lucide-react";
import { get, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { NeedsRepo } from "../../components/AppShell";
import { PageHeader, Panel, Tabs, Button, Stat, EmptyState, LoadingBlock, SeverityBadge, StatusBadge, Badge, Notice, Table } from "../../components/ui";
import { JobPanel, useActiveJobs } from "../../components/jobs";
import { FindingExplorer } from "./Findings";
import { SEVERITIES, SEV_COLOR, timeAgo, titleCase } from "../../lib/format";

type Tab = "overview" | "vulns" | "secrets" | "deps" | "priority" | "history";

export default function Security() {
  return <NeedsRepo>{(repo) => <SecurityView repo={repo} />}</NeedsRepo>;
}

function SecurityView({ repo }: { repo: any }) {
  const [tab, setTab] = useState<Tab>("overview");
  const { can } = useAuth();
  const jobs = useActiveJobs((j) => j.payload?.repositoryId === repo.id);
  const all = useQuery({ queryKey: ["findings", "sec-all", repo.id], queryFn: () => get(`/findings?repo=${repo.id}&source=security,secret,dependency&limit=500`) });
  const scans = useQuery({ queryKey: ["scans", repo.id], queryFn: () => get(`/repositories/${repo.id}/scans`) });
  const secScans = (scans.data ?? []).filter((s: any) => s.kind === "security" || s.kind === "dependency");
  const lastSec = secScans.find((s: any) => s.kind === "security");
  const items = all.data?.items ?? [];
  const count = (src: string) => items.filter((i: any) => i.source === src).length;
  const crit = items.filter((i: any) => i.severity === "critical" || i.severity === "high").length;
  const scan = async () => { try { await post(`/repositories/${repo.id}/analyze`, { kinds: ["security", "dependency"] }); toast.success("Security scan started"); } catch (e: any) { toast.error(e.message); } };
  const report = async () => { try { const r = await post("/reports", { repositoryId: repo.id, kind: "security" }); toast.success("Security report generated"); window.location.href = `/app/reports?id=${r.id}`; } catch (e: any) { toast.error(e.message); } };
  const byCat = Object.entries(items.reduce((a: any, i: any) => { (a[i.category] ??= Object.fromEntries(SEVERITIES.map((s) => [s, 0])))[i.severity]++; return a; }, {})).map(([k, v]: any) => ({ name: k, ...v }));
  const prioritized = [...items].filter((i) => i.origin === "detected").sort((a, b) => score(b) - score(a)).slice(0, 25);
  return (
    <>
      <PageHeader eyebrow="Security Center" icon={<ShieldCheck className="size-6 text-amber-deep" />} title="Security intelligence" description="Injection, XSS, SSRF, path traversal, insecure configuration, exposed secrets and vulnerable dependencies — from real scanners. Missing tools are reported as not installed, never as passing."
        actions={<>{can("reports.create") && <Button icon={<FileText className="size-4" />} onClick={report}>Security report</Button>}{can("analysis.run") && <Button variant="primary" icon={<ScanSearch className="size-4" />} onClick={scan}>Run security scan</Button>}</>} />
      {jobs.length > 0 && <div className="mb-4 space-y-2">{jobs.map((j: any) => <JobPanel key={j.id} jobId={j.id} compact />)}</div>}
      <Tabs className="mb-5" value={tab} onChange={setTab} tabs={[{ id: "overview", label: "Overview" }, { id: "vulns", label: "Vulnerabilities", count: count("security") }, { id: "secrets", label: "Secrets", count: count("secret") }, { id: "deps", label: "Dependency risks", count: count("dependency") }, { id: "priority", label: "Risk prioritization" }, { id: "history", label: "Scan history" }]} />
      {tab === "overview" && (all.isLoading ? <LoadingBlock /> : (
        <>
          <div className="mb-4 grid gap-3 md:grid-cols-4">
            <Stat label="Critical & high" value={crit} tone={crit ? "danger" : "success"} icon={<ShieldCheck className="size-4" />} />
            <Stat label="Code vulnerabilities" value={count("security")} icon={<ScanSearch className="size-4" />} />
            <Stat label="Exposed secrets" value={count("secret")} tone={count("secret") ? "danger" : undefined} icon={<KeyRound className="size-4" />} />
            <Stat label="Dependency risks" value={count("dependency")} icon={<Boxes className="size-4" />} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="Findings by category" className="lg:col-span-2">
              {byCat.length ? (
                <ResponsiveContainer width="100%" height={Math.max(200, byCat.length * 34)}>
                  <BarChart data={byCat} layout="vertical" margin={{ left: 40 }}>
                    <CartesianGrid stroke="#EFECE5" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11, fill: "#A3A199" }} allowDecimals={false} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11.5, fill: "#4A4A44" }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ borderRadius: 10, fontSize: 12 }} cursor={{ fill: "#F7F6F2" }} />
                    {SEVERITIES.map((s) => <Bar key={s} dataKey={s} stackId="a" fill={SEV_COLOR[s]} />)}
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyState icon={<ShieldCheck className="size-5" />} title="No open security findings" description={lastSec ? `Last security scan ${timeAgo(lastSec.finished_at)}.` : "No security scan has run yet."} action={!lastSec && can("analysis.run") && <Button variant="primary" onClick={scan}>Run security scan</Button>} />}
            </Panel>
            <Panel title="Scanner coverage" subtitle={lastSec ? `Last run ${timeAgo(lastSec.finished_at)}` : "No scan yet"}>
              {secScans.length ? (
                <div className="space-y-2">
                  {Object.entries({ ...(secScans.find((s: any) => s.kind === "dependency")?.tools ?? {}), ...(lastSec?.tools ?? {}) }).map(([k, v]: any) => (
                    <div key={k} className="flex items-center gap-2 text-[12.5px]"><span className="w-28 font-medium text-ink">{k}</span><StatusBadge status={v.status} /><span className="truncate text-[11.5px] text-muted" title={v.note}>{v.note}</span></div>
                  ))}
                </div>
              ) : <p className="text-[13px] text-muted">Run a scan to see which tools executed.</p>}
            </Panel>
          </div>
          <Panel title="Top risks" className="mt-4" pad={false}>
            {prioritized.slice(0, 8).map((f) => <Link key={f.id} to={`/app/findings/${f.id}`} className="flex items-center gap-3 border-b border-line-2 px-5 py-2.5 last:border-0 hover:bg-ivory/50"><SeverityBadge severity={f.severity} /><span className="min-w-0 flex-1 truncate text-[13px]">{f.title}</span><span className="font-mono text-[11.5px] text-muted">{f.file_path}{f.line ? `:${f.line}` : ""}</span></Link>)}
            {!prioritized.length && <EmptyState title="Nothing to prioritise" />}
          </Panel>
        </>
      ))}
      {tab === "vulns" && <FindingExplorer repo={repo} sources="security" scanKinds={["security"]} />}
      {tab === "secrets" && <><div className="mb-4"><Notice tone="amber" icon={<KeyRound className="size-4 text-amber-deep" />}>Secret values are masked everywhere in DevForge. Rotate any real credential found here — removing it from the code is not enough because it remains in git history.</Notice></div><FindingExplorer repo={repo} sources="secret" scanKinds={["security"]} /></>}
      {tab === "deps" && <><div className="mb-4 flex justify-end"><Link to="/app/dependencies"><Button size="sm" icon={<Boxes className="size-3.5" />}>Open Dependency Intelligence</Button></Link></div><FindingExplorer repo={repo} sources="dependency" scanKinds={["dependency"]} /></>}
      {tab === "priority" && (
        <Panel title={<span className="flex items-center gap-2"><ListOrdered className="size-4" />Remediation priority</span>} subtitle="Score = severity × confidence × exposure (secrets and injection weighted higher). Detected findings only." pad={false}>
          {prioritized.length ? (
            <Table head={["#", "Finding", "Category", "Location", "Score"]}>
              {prioritized.map((f, i) => (
                <tr key={f.id} className="hover:bg-ivory/50">
                  <td className="px-4 py-2 text-muted">{i + 1}</td>
                  <td className="px-4 py-2"><Link to={`/app/findings/${f.id}`} className="flex items-center gap-2"><SeverityBadge severity={f.severity} /><span className="text-ink hover:text-amber-deep">{f.title}</span></Link></td>
                  <td className="px-4 py-2 text-muted">{f.category}</td>
                  <td className="px-4 py-2 font-mono text-[11.5px] text-muted">{f.file_path}{f.line ? `:${f.line}` : ""}</td>
                  <td className="px-4 py-2 font-semibold tabular-nums">{score(f)}</td>
                </tr>
              ))}
            </Table>
          ) : <EmptyState title="No detected security findings" />}
        </Panel>
      )}
      {tab === "history" && (
        <Panel pad={false}>
          {secScans.length ? (
            <Table head={["Scan", "Status", "Result", "Tools", "When"]}>
              {secScans.map((s: any) => (
                <tr key={s.id}>
                  <td className="px-4 py-2.5 font-medium capitalize"><History className="mr-1.5 inline size-3.5 text-faint" />{s.kind}</td>
                  <td className="px-4 py-2.5"><StatusBadge status={s.status} /></td>
                  <td className="px-4 py-2.5 text-[12.5px]">{s.summary?.findings ?? "—"} findings{s.summary?.created ? `, ${s.summary.created} new` : ""}{s.summary?.autoResolved ? `, ${s.summary.autoResolved} resolved` : ""}</td>
                  <td className="px-4 py-2.5"><div className="flex flex-wrap gap-1">{Object.entries(s.tools).map(([k, v]: any) => <Badge key={k} tone={v.status === "ok" ? "success" : v.status === "failed" ? "danger" : "neutral"}>{k}: {titleCase(v.status)}</Badge>)}</div></td>
                  <td className="px-4 py-2.5 text-[12.5px] text-muted">{timeAgo(s.finished_at ?? s.started_at)}</td>
                </tr>
              ))}
            </Table>
          ) : <EmptyState title="No security scans yet" />}
        </Panel>
      )}
    </>
  );
}

function score(f: any) {
  const sev = { critical: 10, high: 7, medium: 4, low: 2, info: 1 }[f.severity as string] ?? 1;
  const conf = { high: 1, medium: 0.7, low: 0.4 }[f.confidence as string] ?? 0.5;
  const exposure = f.source === "secret" ? 1.5 : /injection|XSS|SSRF|traversal|deserialization/i.test(f.category) ? 1.3 : f.source === "dependency" ? 1.1 : 1;
  return Math.round(sev * conf * exposure * 10);
}

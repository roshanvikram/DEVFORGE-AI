import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Boxes, ScanSearch, Search, ExternalLink } from "lucide-react";
import { get, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { NeedsRepo } from "../../components/AppShell";
import { PageHeader, Panel, Button, Input, Select, Stat, EmptyState, LoadingBlock, Badge, SeverityBadge, StatusBadge, Notice, Table, Modal, Tabs, cx } from "../../components/ui";
import { JobPanel, useActiveJobs } from "../../components/jobs";
import { AdvisoryWatch } from "../../components/advisories";
import { timeAgo } from "../../lib/format";

const COPYLEFT = /\b(A?GPL|LGPL|SSPL|EUPL|MPL|CC-BY-SA|OSL)/i;
const major = (v?: string | null) => (v ? parseInt(v.replace(/^[^\d]*/, ""), 10) : NaN);

export default function Dependencies() {
  return <NeedsRepo>{(repo) => <DepsView repo={repo} />}</NeedsRepo>;
}

function DepsView({ repo }: { repo: any }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["deps", repo.id, repo.last_analyzed_at], queryFn: () => get(`/repositories/${repo.id}/dependencies`) });
  const jobs = useActiveJobs((j) => j.payload?.repositoryId === repo.id);
  const [filter, setFilter] = useState({ q: "", status: "all", eco: "all", scope: "all" });
  const [sel, setSel] = useState<any>(null);
  const [view, setView] = useState<"table" | "graph">("table");
  const deps = q.data?.dependencies ?? [];
  const status = (d: any) => (d.vulns.length ? "vulnerable" : d.latest_version && d.resolved_version && major(d.latest_version) > major(d.resolved_version) ? "major-behind" : d.latest_version && d.resolved_version && d.latest_version !== d.resolved_version ? "minor-behind" : d.latest_version ? "current" : "unknown");
  const rows = useMemo(() => deps.filter((d: any) => (!filter.q || d.name.toLowerCase().includes(filter.q.toLowerCase())) && (filter.status === "all" || status(d) === filter.status || (filter.status === "license" && d.license && COPYLEFT.test(d.license))) && (filter.eco === "all" || d.ecosystem === filter.eco) && (filter.scope === "all" || (filter.scope === "dev" ? d.dev : !d.dev))), [deps, filter]);
  const ecos = [...new Set(deps.map((d: any) => d.ecosystem))] as string[];
  const vulnerable = deps.filter((d: any) => d.vulns.length).length;
  const conflicts = useMemo(() => { const m = new Map<string, Set<string>>(); deps.forEach((d: any) => d.resolved_version && (m.get(d.name) ?? m.set(d.name, new Set()).get(d.name)!).add(d.resolved_version)); return [...m.entries()].filter(([, v]) => v.size > 1); }, [deps]);
  const unused = deps.filter((d: any) => !d.dev && d.ecosystem === "npm" && d.importedByFiles === 0 && !d.name.startsWith("@types/"));
  const scan = async () => { try { await post(`/repositories/${repo.id}/analyze`, { kinds: ["dependency"] }); toast.success("Dependency scan started"); } catch (e: any) { toast.error(e.message); } };
  const tools = q.data?.lastScan?.tools ?? {};
  return (
    <>
      <PageHeader eyebrow="Dependency Intelligence" icon={<Boxes className="size-6 text-amber-deep" />} title="Dependencies" description="Parsed from your manifests and lockfiles (npm, PyPI, Go, crates.io, RubyGems). Vulnerabilities from OSV.dev and npm audit; latest versions and licenses from public registries."
        actions={can("analysis.run") && <Button variant="primary" icon={<ScanSearch className="size-4" />} onClick={scan}>Scan dependencies</Button>} />
      {jobs.length > 0 && <div className="mb-4 space-y-2">{jobs.map((j: any) => <JobPanel key={j.id} jobId={j.id} compact />)}</div>}
      <AdvisoryWatch repo={repo} />
      {q.data?.lastScan ? <div className="mb-4 flex flex-wrap items-center gap-2 text-[12px] text-muted">Last scan {timeAgo(q.data.lastScan.finished_at)} · {Object.entries(tools).map(([k, v]: any) => <span key={k} title={v.note}><Badge tone={v.status === "ok" ? "success" : v.status === "failed" ? "danger" : "neutral"}>{k}: {v.status}</Badge></span>)}</div> : <div className="mb-4"><Notice tone="amber">No dependency scan has run for this snapshot yet.</Notice></div>}
      <div className="mb-4 grid gap-3 md:grid-cols-5">
        <Stat label="Dependencies" value={deps.length} sub={`${deps.filter((d: any) => d.dev).length} dev`} />
        <Stat label="Vulnerable" value={vulnerable} tone={vulnerable ? "danger" : "success"} />
        <Stat label="Major versions behind" value={deps.filter((d: any) => status(d) === "major-behind").length} tone="amber" />
        <Stat label="License risks" value={deps.filter((d: any) => d.license && COPYLEFT.test(d.license) && !d.dev).length} />
        <Stat label="Possibly unused" value={unused.length} sub="npm runtime deps never imported" />
      </div>
      {conflicts.length > 0 && <div className="mb-4"><Notice tone="amber">Version conflicts: {conflicts.map(([n, v]) => `${n} (${[...v].join(", ")})`).join("; ")}</Notice></div>}
      <Tabs className="mb-3" value={view} onChange={setView} tabs={[{ id: "table", label: "Explorer" }, { id: "graph", label: "Dependency graph" }]} />
      {view === "graph" ? <DepGraph deps={deps} onSelect={setSel} status={status} /> : (
        <Panel pad={false}>
          <div className="flex flex-wrap gap-2 border-b border-line-2 p-3">
            <div className="relative flex-1"><Search className="absolute left-2.5 top-2.5 size-4 text-faint" /><Input className="pl-8" placeholder="Search packages" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} /></div>
            <Select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}><option value="all">All statuses</option><option value="vulnerable">Vulnerable</option><option value="major-behind">Major behind</option><option value="minor-behind">Minor/patch behind</option><option value="current">Current</option><option value="license">Copyleft license</option><option value="unknown">Unknown</option></Select>
            <Select value={filter.eco} onChange={(e) => setFilter({ ...filter, eco: e.target.value })}><option value="all">All ecosystems</option>{ecos.map((e) => <option key={e}>{e}</option>)}</Select>
            <Select value={filter.scope} onChange={(e) => setFilter({ ...filter, scope: e.target.value })}><option value="all">All scopes</option><option value="prod">Runtime</option><option value="dev">Dev</option></Select>
          </div>
          {q.isLoading ? <div className="p-5"><LoadingBlock /></div> : !rows.length ? <EmptyState icon={<Boxes className="size-5" />} title={deps.length ? "No packages match" : "No dependencies found"} description={deps.length ? undefined : "No supported manifest was found, or the dependency scan hasn't run."} /> : (
            <Table head={["Package", "Declared", "Resolved", "Latest", "License", "Status", "Used in"]}>
              {rows.map((d: any) => (
                <tr key={d.id} className="cursor-pointer hover:bg-ivory/50" onClick={() => setSel(d)}>
                  <td className="px-4 py-2"><div className="font-mono text-[12.5px] text-ink">{d.name}</div><div className="text-[11px] text-muted">{d.ecosystem} · {d.manifest_path}{d.dev ? " · dev" : ""}</div></td>
                  <td className="px-4 py-2 font-mono text-[12px] text-muted">{d.version_spec ?? "—"}</td>
                  <td className="px-4 py-2 font-mono text-[12px]">{d.resolved_version ?? <span className="text-faint">no lockfile</span>}</td>
                  <td className="px-4 py-2 font-mono text-[12px]">{d.latest_version ?? "—"}</td>
                  <td className="px-4 py-2 text-[12px]"><span className={cx(d.license && COPYLEFT.test(d.license) && "font-medium text-amber-deep")}>{d.license ?? "—"}</span></td>
                  <td className="px-4 py-2"><DepStatus s={status(d)} n={d.vulns.length} /></td>
                  <td className="px-4 py-2 text-[12px] text-muted">{d.ecosystem === "npm" || d.ecosystem === "PyPI" ? `${d.importedByFiles} files` : "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      )}
      <Modal open={!!sel} onClose={() => setSel(null)} title={<span className="font-mono">{sel?.name}</span>} width={640}>
        {sel && (
          <div className="space-y-4 text-[13px]">
            <div className="grid grid-cols-2 gap-3"><div><div className="text-muted">Declared</div><div className="font-mono">{sel.version_spec ?? "—"}</div></div><div><div className="text-muted">Resolved</div><div className="font-mono">{sel.resolved_version ?? "—"}</div></div><div><div className="text-muted">Latest</div><div className="font-mono">{sel.latest_version ?? "—"}</div></div><div><div className="text-muted">License</div><div>{sel.license ?? "—"}</div></div></div>
            <div><div className="mb-2 font-medium text-ink">Vulnerabilities ({sel.vulns.length})</div>{sel.vulns.map((v: any) => <div key={v.id} className="mb-2 rounded-xl border border-line p-3"><div className="flex items-center gap-2"><SeverityBadge severity={v.severity} /><a href={v.url} target="_blank" rel="noreferrer noopener" className="font-mono text-[12px] text-amber-deep underline">{v.id}</a>{v.aliases?.slice(0, 2).map((a: string) => <Badge key={a}>{a}</Badge>)}</div><p className="mt-1.5 text-ink-2">{v.summary}</p>{v.fixed && <p className="mt-1 text-[12px] text-success">Fixed in {v.fixed}</p>}</div>)}{!sel.vulns.length && <p className="text-muted">No known vulnerabilities for this version{sel.checked_at ? "" : " (not checked yet)"}.</p>}</div>
            <div><div className="mb-1 font-medium text-ink">Upgrade impact</div><p className="text-ink-2">{sel.latest_version && sel.resolved_version && major(sel.latest_version) > major(sel.resolved_version) ? `Major upgrade ${sel.resolved_version} → ${sel.latest_version}: expect breaking API changes. ` : sel.latest_version && sel.resolved_version && sel.latest_version !== sel.resolved_version ? `Minor/patch upgrade to ${sel.latest_version}: usually backward compatible. ` : "Up to date or unknown. "}{sel.importedByFiles ? `Imported directly in ${sel.importedByFiles} file(s) — review those call sites.` : "Not imported directly by indexed source files."}</p></div>
            {sel.ecosystem === "npm" && <a href={`https://www.npmjs.com/package/${sel.name}`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[12.5px] text-amber-deep">npm registry <ExternalLink className="size-3" /></a>}
            {sel.ecosystem === "PyPI" && <a href={`https://pypi.org/project/${sel.name}`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[12.5px] text-amber-deep">PyPI <ExternalLink className="size-3" /></a>}
          </div>
        )}
      </Modal>
    </>
  );
}

function DepStatus({ s, n }: { s: string; n: number }) {
  if (s === "vulnerable") return <Badge tone="danger">{n} vulnerabilit{n === 1 ? "y" : "ies"}</Badge>;
  if (s === "major-behind") return <Badge tone="amber">major behind</Badge>;
  if (s === "minor-behind") return <Badge tone="info">update available</Badge>;
  if (s === "current") return <Badge tone="success">current</Badge>;
  return <Badge>unknown</Badge>;
}

function DepGraph({ deps, onSelect, status }: { deps: any[]; onSelect: (d: any) => void; status: (d: any) => string }) {
  const manifests = [...new Set(deps.map((d) => d.manifest_path))];
  if (!deps.length) return <Panel><EmptyState title="No dependencies" /></Panel>;
  const W = 1000;
  const H = Math.max(360, Math.ceil(deps.length / manifests.length) * 22 + 80);
  const color: Record<string, string> = { vulnerable: "#D94C4C", "major-behind": "#D99A28", "minor-behind": "#6B7F96", current: "#23966A", unknown: "var(--color-silver)" };
  return (
    <Panel pad={false} className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="min-w-[760px]" role="img" aria-label="Dependency graph by manifest">
        {manifests.map((m, mi) => {
          const mx = 120;
          const my = 40 + (mi * (H - 80)) / Math.max(1, manifests.length - 1 || 1) * (manifests.length > 1 ? 1 : 0) + (manifests.length === 1 ? (H - 80) / 2 : 0);
          const ds = deps.filter((d) => d.manifest_path === m);
          return (
            <g key={m}>
              {ds.map((d, i) => {
                const x = 380 + (i % 2) * 300;
                const y = 30 + (i * (H - 60)) / Math.max(1, ds.length);
                return (
                  <g key={d.id} className="cursor-pointer" onClick={() => onSelect(d)}>
                    <path d={`M${mx + 90} ${my} C ${mx + 200} ${my}, ${x - 120} ${y}, ${x - 8} ${y}`} fill="none" stroke={color[status(d)]} strokeOpacity={0.35} />
                    <circle cx={x} cy={y} r={5} fill={color[status(d)]} />
                    <text x={x + 10} y={y + 4} fontSize={11} fill="var(--color-ink-2)" fontFamily="JetBrains Mono Variable, monospace">{d.name}{d.dev ? " (dev)" : ""}</text>
                  </g>
                );
              })}
              <rect x={mx - 90} y={my - 16} width={180} height={32} rx={10} fill="white" stroke="#D99A28" />
              <text x={mx} y={my + 4} textAnchor="middle" fontSize={11.5} fill="var(--color-ink)">{m}</text>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-3 border-t border-line-2 px-4 py-2 text-[11.5px] text-muted">{Object.entries(color).map(([k, c]) => <span key={k} className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: c }} />{k}</span>)}</div>
    </Panel>
  );
}

export { StatusBadge, Link };

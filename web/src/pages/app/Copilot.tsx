import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Database, RefreshCw, Send, CheckCircle2, AlertTriangle, FileCode2, BookOpen, History } from "lucide-react";
import { get, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useEvent } from "../../lib/realtime";
import { NeedsRepo } from "../../components/AppShell";
import { PageHeader, Panel, Button, Textarea, Badge, Notice, EmptyState, LoadingBlock, Markdown, CodeBlock, cx } from "../../components/ui";
import { JobPanel } from "../../components/jobs";
import { timeAgo, num } from "../../lib/format";

type Source = { n: number; kind: "code" | "doc"; path: string; title?: string; startLine: number; endLine: number; symbol: string | null; preview: string; score: number; signals: Record<string, number> };
type Run = { id: string; question: string; phase: string; sources: Source[]; answer: string; citations: { ref: string; source: number | null; verified: boolean }[]; note?: string; error?: string; provider?: string; model?: string; retrievalMs?: number; totalMs?: number };

const SIGNAL: Record<string, { label: string; cls: string }> = {
  vector: { label: "vector", cls: "bg-iris-soft text-iris" },
  bm25: { label: "keyword", cls: "bg-amber-soft text-amber-deep" },
  symbol: { label: "symbol", cls: "bg-success-soft text-success" },
  graph: { label: "import graph", cls: "bg-info-soft text-info" },
  kb: { label: "knowledge base", cls: "bg-ivory text-ink-2" },
};
const EXT_LANG: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python", go: "go", rs: "rust", css: "css", sql: "sql" };

function fromStored(q: any): Run {
  return { id: q.id, question: q.question, phase: q.status === "running" ? "generating" : q.status === "failed" ? "error" : "done", sources: q.sources ?? [], answer: q.answer ?? "", citations: q.citations ?? [], note: q.status === "retrieval_only" ? q.error : undefined, error: q.status === "failed" ? q.error : undefined, provider: q.provider, model: q.model, retrievalMs: q.retrieval_ms, totalMs: q.total_ms };
}

function CopilotView({ repo }: { repo: any }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ["rag", repo.id], queryFn: () => get<any>(`/repositories/${repo.id}/rag`) });
  const caps = useQuery({ queryKey: ["capabilities"], queryFn: () => get<any>("/system/capabilities") });
  const [question, setQuestion] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [indexJob, setIndexJob] = useState<string | null>(null);
  const pending = useRef(new Map<string, any[]>()); // events that arrive before the POST returns
  const activeId = useRef<string | null>(null);

  const apply = (r: Run, e: any): Run => {
    switch (e.phase) {
      case "retrieving": return { ...r, phase: "retrieving" };
      case "sources": return { ...r, phase: "sources", sources: e.sources, retrievalMs: e.retrievalMs };
      case "generating": return { ...r, phase: "generating", provider: e.provider, model: e.model };
      case "token": return { ...r, phase: "generating", answer: r.answer + e.text };
      case "done": return { ...r, phase: "done", answer: e.answer ?? r.answer, citations: e.citations ?? [], note: e.note, totalMs: e.totalMs, model: e.model ?? r.model };
      case "error": return { ...r, phase: "error", error: e.error };
      default: return r;
    }
  };
  useEvent((e: any) => {
    if (e.type === "rag.index") qc.invalidateQueries({ queryKey: ["rag", repo.id] });
    if (e.type !== "rag") return;
    if (e.id !== activeId.current) {
      pending.current.set(e.id, [...(pending.current.get(e.id) ?? []), e]);
      return;
    }
    setRun((r) => (r ? apply(r, e) : r));
    if (e.phase === "done" || e.phase === "error") qc.invalidateQueries({ queryKey: ["rag", repo.id] });
  }, [repo.id]);

  const askQ = async (text: string) => {
    if (text.trim().length < 3) return;
    try {
      const { id } = await post<{ id: string }>(`/repositories/${repo.id}/rag/ask`, { question: text.trim() });
      activeId.current = id;
      let r: Run = { id, question: text.trim(), phase: "retrieving", sources: [], answer: "", citations: [] };
      for (const e of pending.current.get(id) ?? []) r = apply(r, e);
      pending.current.delete(id);
      setRun(r);
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  const openHistory = async (id: string) => {
    activeId.current = id;
    setRun(fromStored(await get(`/rag/queries/${id}`)));
  };
  const rebuild = async () => {
    try {
      const { jobId } = await post<{ jobId: string }>(`/repositories/${repo.id}/rag/index`);
      setIndexJob(jobId);
    } catch (e: any) { toast.error(e.message); }
  };

  const idx = st.data?.index;
  const busy = run && !["done", "error"].includes(run.phase);
  const aiOn = caps.data?.ai?.configured;
  return (
    <>
      <PageHeader eyebrow="Intelligence" icon={<Sparkles className="size-6 text-iris" />} title={<>RAG <span className="aurora-text">Copilot</span></>}
        description="Ask anything about this codebase. Answers are grounded in retrieved code — vector, keyword, symbol and import-graph retrieval fused together — and every citation is checked against the sources." />

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          <Panel className="aurora-ring">
            <form onSubmit={(e) => { e.preventDefault(); askQ(question); }} className="space-y-3">
              <Textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} placeholder={`Ask about ${repo.name} — e.g. "Where are database queries built?"`}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); askQ(question); } }} aria-label="Question" />
              <div className="flex flex-wrap items-center gap-2">
                {["Where is authentication handled?", "How are errors handled?", "What are the main entry points?"].map((s) => (
                  <button key={s} type="button" onClick={() => { setQuestion(s); askQ(s); }} className="rounded-full bg-ivory px-3 py-1 text-[12px] text-ink-2 ring-1 ring-line transition hover:ring-iris/40">{s}</button>
                ))}
                <Button type="submit" variant="aurora" className="ml-auto" loading={!!busy} disabled={!can("ai.use") || question.trim().length < 3} icon={<Send className="size-4" />}>Ask</Button>
              </div>
              {!aiOn && caps.data && <Notice tone="info">No AI provider connected — the copilot still retrieves and ranks the relevant code; connect Claude or Groq in <Link className="font-medium underline" to="/app/integrations">Integrations</Link> for written answers.</Notice>}
            </form>
          </Panel>

          <AnimatePresence mode="wait">
            {run ? (
              <motion.div key={run.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                <Panel title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-iris" />{run.question}</span>}
                  subtitle={[run.retrievalMs != null && `retrieval ${run.retrievalMs} ms`, run.totalMs != null && `total ${(run.totalMs / 1000).toFixed(1)} s`, run.model && `${run.provider === "groq" ? "Groq" : "Claude"} · ${run.model}`].filter(Boolean).join(" · ") || undefined}>
                  {busy && <div className="aurora-live mb-3 h-1 rounded-full" />}
                  {run.phase === "retrieving" && <p className="text-[13px] text-muted">Retrieving relevant code…</p>}
                  {run.phase === "sources" && !run.answer && <p className="text-[13px] text-muted">Found {run.sources.length} sources. {aiOn ? "Generating answer…" : ""}</p>}
                  {run.answer && <Markdown>{run.answer + (run.phase === "generating" ? " ▍" : "")}</Markdown>}
                  {run.note && <Notice tone="info">{run.note}</Notice>}
                  {run.error && <Notice tone="danger">{run.error}</Notice>}
                  {run.phase === "done" && run.citations.length > 0 && (
                    <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-line-2 pt-3">
                      <span className="mr-1 text-[11.5px] font-medium uppercase tracking-[0.08em] text-muted">Citations</span>
                      {run.citations.map((c) => (
                        <span key={c.ref} title={c.verified ? "Matches a retrieved source" : "Not found in the retrieved sources — treat with caution"} className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] ring-1", c.verified ? "bg-success-soft text-success ring-success/20" : "bg-danger-soft text-danger ring-danger/20")}>
                          {c.verified ? <CheckCircle2 className="size-3" /> : <AlertTriangle className="size-3" />}{c.ref}
                        </span>
                      ))}
                    </div>
                  )}
                </Panel>
                {run.sources.length > 0 && (
                  <Panel title="Sources" subtitle="Ranked by reciprocal-rank fusion; chips show which retrievers found each chunk and at what rank">
                    <div className="space-y-3">
                      {run.sources.map((s) => (
                        <div key={s.n} className="rounded-xl ring-1 ring-line">
                          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                            <span className="aurora-bg grid size-5 place-items-center rounded-md text-[11px] font-semibold text-[#fff]">{s.n}</span>
                            {s.kind === "doc" ? <BookOpen className="size-3.5 text-muted" /> : <FileCode2 className="size-3.5 text-muted" />}
                            <span className="font-mono text-[12px] text-ink">{s.kind === "doc" ? s.title : `${s.path}:${s.startLine}-${s.endLine}`}</span>
                            {s.symbol && <span className="text-[11.5px] text-muted">in {s.symbol}</span>}
                            <span className="ml-auto flex flex-wrap gap-1">{Object.entries(s.signals).map(([k, rank]) => <span key={k} className={cx("rounded-full px-1.5 py-0.5 text-[10.5px] font-medium", SIGNAL[k]?.cls)}>{SIGNAL[k]?.label ?? k} #{rank}</span>)}</span>
                          </div>
                          <CodeBlock code={s.preview} language={s.kind === "doc" ? "markdown" : EXT_LANG[s.path.split(".").pop() ?? ""] ?? "tsx"} startLine={s.kind === "code" ? s.startLine : 1} maxHeight={180} />
                        </div>
                      ))}
                    </div>
                  </Panel>
                )}
              </motion.div>
            ) : (
              <Panel><EmptyState icon={<Sparkles className="size-5 text-iris" />} title="Ask your first question" description="The copilot searches this repository's own code — nothing is sent anywhere until an answer is requested from your configured AI provider." /></Panel>
            )}
          </AnimatePresence>
        </div>

        <div className="space-y-4">
          <Panel title={<span className="flex items-center gap-2"><Database className="size-4 text-iris" />Semantic index</span>}
            actions={can("analysis.run") && <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={rebuild}>Rebuild</Button>}>
            {st.isLoading ? <LoadingBlock rows={2} /> : idx?.ready ? (
              <dl className="grid grid-cols-2 gap-2 text-[12px]">
                <div className="rounded-lg bg-ivory/70 px-3 py-2 ring-1 ring-line"><dt className="text-muted">Chunks</dt><dd className="text-[16px] font-semibold text-ink">{num(idx.chunks)}</dd></div>
                <div className="rounded-lg bg-ivory/70 px-3 py-2 ring-1 ring-line"><dt className="text-muted">Files</dt><dd className="text-[16px] font-semibold text-ink">{num(idx.files)}</dd></div>
                <div className="col-span-2 text-[11.5px] leading-relaxed text-muted">{idx.dims}-dim {idx.embedding}. Built {timeAgo(idx.built_at)} in {idx.build_ms} ms; refreshed automatically after every analysis. Indexing never leaves this server.</div>
              </dl>
            ) : <Notice tone="info">No index yet for the current snapshot. It is built automatically after analysis, on first question, or with Rebuild.</Notice>}
            {indexJob && <div className="mt-3"><JobPanel jobId={indexJob} compact onFinished={() => qc.invalidateQueries({ queryKey: ["rag", repo.id] })} /></div>}
          </Panel>
          <Panel title={<span className="flex items-center gap-2"><History className="size-4 text-muted" />Your recent questions</span>} pad={false}>
            {st.data?.history?.length ? (
              <ul>
                {st.data.history.map((h: any) => (
                  <li key={h.id}><button onClick={() => openHistory(h.id)} className={cx("w-full border-b border-line-2 px-4 py-2.5 text-left transition last:border-0 hover:bg-ivory/60", run?.id === h.id && "bg-iris-soft/50")}>
                    <div className="line-clamp-2 text-[13px] text-ink">{h.question}</div>
                    <div className="mt-0.5 text-[11px] text-muted">{h.status === "retrieval_only" ? "evidence only" : h.status} · {timeAgo(h.created_at)}</div>
                  </button></li>
                ))}
              </ul>
            ) : <div className="p-4 text-[12.5px] text-muted">Questions you ask appear here.</div>}
          </Panel>
        </div>
      </div>
    </>
  );
}

export default function CopilotPage() {
  return <NeedsRepo>{(repo) => <CopilotView key={repo.id} repo={repo} />}</NeedsRepo>;
}

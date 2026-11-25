import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Highlight, themes } from "prism-react-renderer";
import { AlertTriangle, Inbox, Loader2, X, RefreshCw, Sparkles, ShieldCheck } from "lucide-react";
import { SEV_COLOR } from "../lib/format";
import { gradeFor } from "../lib/grade";
export { gradeFor };
import { ApiError } from "../lib/api";

export const cx = clsx;

// ---------------------------------------------------------------- Buttons
type BtnVariant = "primary" | "secondary" | "ghost" | "danger" | "amber";
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md" | "lg"; loading?: boolean; icon?: ReactNode }>(
  ({ variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] font-medium transition-all duration-150 select-none disabled:opacity-50 disabled:cursor-not-allowed active:scale-[.985]",
        size === "sm" && "h-8 px-3 text-[13px]",
        size === "md" && "h-9 px-4 text-[13.5px]",
        size === "lg" && "h-11 px-6 text-[15px]",
        variant === "primary" && "bg-ink text-white shadow-[0_1px_0_rgba(255,255,255,.15)_inset,0_6px_16px_-6px_rgba(36,37,33,.5)] hover:bg-[#33342f]",
        variant === "amber" && "bg-amber text-white shadow-[0_1px_0_rgba(255,255,255,.3)_inset,0_8px_20px_-8px_rgba(217,154,40,.8)] hover:bg-amber-deep",
        variant === "secondary" && "bg-white text-ink border border-line shadow-[0_1px_2px_rgba(36,37,33,.05)] hover:border-silver hover:bg-[#fdfcfa]",
        variant === "ghost" && "text-ink-2 hover:bg-ivory",
        variant === "danger" && "bg-white text-danger border border-danger/30 hover:bg-danger-soft",
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  ),
);

// ---------------------------------------------------------------- Inputs
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cx("h-9 w-full rounded-[10px] border border-line bg-white px-3 text-[13.5px] text-ink placeholder:text-faint outline-none transition focus:border-amber focus:ring-4 focus:ring-amber-soft/60", className)} {...p} />
));
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} className={cx("w-full rounded-[10px] border border-line bg-white px-3 py-2 text-[13.5px] text-ink placeholder:text-faint outline-none transition focus:border-amber focus:ring-4 focus:ring-amber-soft/60", className)} {...p} />
));
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...p }, ref) => (
  <select ref={ref} className={cx("h-9 rounded-[10px] border border-line bg-white px-3 pr-8 text-[13.5px] text-ink outline-none focus:border-amber focus:ring-4 focus:ring-amber-soft/60", className)} {...p}>{children}</select>
));
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-[12px] text-danger">{error}</span> : hint ? <span className="mt-1 block text-[12px] text-muted">{hint}</span> : null}
    </label>
  );
}
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className="inline-flex items-center gap-2.5 disabled:opacity-50">
      <span className={cx("relative h-5 w-9 rounded-full transition", checked ? "bg-amber" : "bg-[#dcd8ce]")}>
        <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition-all", checked ? "left-[18px]" : "left-0.5")} />
      </span>
      {label && <span className="text-[13px] text-ink-2">{label}</span>}
    </button>
  );
}

// ---------------------------------------------------------------- Surfaces
export function Panel({ className, children, title, actions, subtitle, pad = true }: { className?: string; children?: ReactNode; title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; pad?: boolean }) {
  return (
    <section className={cx("panel min-w-0", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line-2 px-5 py-3.5">
          <div className="min-w-0">
            {title && <h3 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-ink">{title}</h3>}
            {subtitle && <p className="mt-0.5 truncate text-[12px] text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx(pad && "p-5")}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, eyebrow, description, actions, icon }: { title: ReactNode; eyebrow?: string; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-deep">{eyebrow}</div>}
        <h1 className="flex items-center gap-3 text-[26px] font-semibold tracking-[-0.025em] text-ink">{icon}{title}</h1>
        {description && <p className="mt-1.5 max-w-3xl text-[14px] leading-relaxed text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, tone, icon }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "danger" | "success" | "amber" | "info"; icon?: ReactNode }) {
  return (
    <div className="panel relative overflow-hidden p-4">
      <div className="flex items-center justify-between text-[12px] font-medium text-muted">
        <span>{label}</span>
        <span className="text-faint">{icon}</span>
      </div>
      <div className={cx("mt-2 text-[26px] font-semibold tracking-[-0.03em] tabular-nums", tone === "danger" && "text-danger", tone === "success" && "text-success", tone === "amber" && "text-amber-deep", tone === "info" && "text-info", !tone && "text-ink")}>{value}</div>
      {sub && <div className="mt-1 text-[12px] text-muted">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Badges
export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "amber" | "success" | "danger" | "info" | "dark"; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
      tone === "neutral" && "bg-ivory text-ink-2 ring-1 ring-line",
      tone === "amber" && "bg-amber-soft text-amber-deep",
      tone === "success" && "bg-success-soft text-success",
      tone === "danger" && "bg-danger-soft text-danger",
      tone === "info" && "bg-info-soft text-info",
      tone === "dark" && "bg-ink text-white",
      className)}>{children}</span>
  );
}
export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold capitalize ring-1 ring-line" style={{ color: SEV_COLOR[severity] }}>
      <span className="size-1.5 rounded-full" style={{ background: SEV_COLOR[severity] }} />
      {severity}
    </span>
  );
}
export function OriginBadge({ origin }: { origin: string }) {
  return origin === "ai_hypothesis" ? <Badge tone="info"><Sparkles className="size-3" />AI hypothesis</Badge> : <Badge tone="success"><ShieldCheck className="size-3" />Detected</Badge>;
}
const STATUS_TONE: Record<string, "neutral" | "amber" | "success" | "danger" | "info" | "dark"> = {
  completed: "success", passed: "success", ready: "success", approved: "success", resolved: "success", connected: "success", ok: "success",
  running: "amber", planning: "amber", generating: "amber", importing: "amber", indexing: "amber", queued: "neutral", pending: "neutral", waiting: "info", waiting_approval: "info", in_progress: "amber", triaged: "info",
  failed: "danger", error: "danger", rejected: "danger", timed_out: "danger", cancelled: "neutral", skipped: "neutral", not_installed: "neutral", disconnected: "neutral",
  scenarios_only: "info", not_executed: "info", open: "amber", ignored: "neutral", false_positive: "neutral", idle: "neutral", partial: "amber",
};
export function StatusBadge({ status }: { status: string }) {
  const live = ["running", "planning", "generating", "importing", "indexing", "in_progress"].includes(status);
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"}>
      {live && <span className="relative flex size-1.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-amber opacity-60" /><span className="relative inline-flex size-1.5 rounded-full bg-amber" /></span>}
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

// ---------------------------------------------------------------- States
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} />;
}
export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return <div className="space-y-3">{Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>;
}
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-4 animate-spin text-muted", className)} />;
}
export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-gradient-to-b from-white to-ivory text-muted ring-1 ring-line shadow-[var(--shadow-pearl)]">{icon ?? <Inbox className="size-5" />}</div>
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Something went wrong";
  return (
    <div className="flex items-start gap-3 rounded-xl border border-danger/20 bg-danger-soft/50 p-4">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="flex-1 text-[13px] text-ink-2">{msg}</div>
      {retry && <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={retry}>Retry</Button>}
    </div>
  );
}
export function Notice({ tone = "info", children, icon }: { tone?: "info" | "amber" | "danger" | "success"; children: ReactNode; icon?: ReactNode }) {
  return (
    <div className={cx("flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px]",
      tone === "info" && "border-info/20 bg-info-soft/60 text-ink-2",
      tone === "amber" && "border-amber/30 bg-amber-soft/50 text-ink-2",
      tone === "danger" && "border-danger/25 bg-danger-soft/60 text-ink-2",
      tone === "success" && "border-success/25 bg-success-soft/60 text-ink-2")}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- Tabs
export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    // Scrolls horizontally on narrow screens instead of widening the page.
    <div className={cx("scroll-thin inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-xl bg-ivory p-1 ring-1 ring-line", className)} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)} className={cx("relative shrink-0 whitespace-nowrap rounded-[9px] px-3 py-1.5 text-[13px] font-medium transition", value === t.id ? "text-ink" : "text-muted hover:text-ink-2")}>
          {value === t.id && <motion.span layoutId={`tab-${tabs.map((x) => x.id).join("")}`} className="absolute inset-0 rounded-[9px] bg-white shadow-[0_1px_3px_rgba(36,37,33,.1)]" transition={{ type: "spring", duration: 0.35, bounce: 0.15 }} />}
          <span className="relative flex items-center gap-1.5">{t.label}{t.count != null && <span className="text-[11px] text-faint tabular-nums">{t.count}</span>}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Modal / Drawer
export function Modal({ open, onClose, title, children, footer, width = 560 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 grid place-items-center bg-[#242521]/25 p-4 backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
          <motion.div role="dialog" aria-modal className="glass-strong max-h-[88vh] w-full overflow-hidden rounded-2xl" style={{ maxWidth: width }} initial={{ y: 12, scale: 0.98, opacity: 0 }} animate={{ y: 0, scale: 1, opacity: 1 }} exit={{ y: 8, opacity: 0 }} transition={{ type: "spring", duration: 0.35, bounce: 0.1 }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-line-2 px-5 py-4">
              <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
              <button className="rounded-lg p-1 text-muted hover:bg-ivory" onClick={onClose} aria-label="Close"><X className="size-4" /></button>
            </div>
            <div className="scroll-thin max-h-[65vh] overflow-y-auto px-5 py-4">{children}</div>
            {footer && <div className="flex justify-end gap-2 border-t border-line-2 bg-ivory/40 px-5 py-3">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ---------------------------------------------------------------- Code & markdown
export function CodeBlock({ code, language = "tsx", startLine = 1, highlightLines = [], maxHeight, onLineClick }: { code: string; language?: string; startLine?: number; highlightLines?: number[]; maxHeight?: number; onLineClick?: (line: number) => void }) {
  const lang = ({ typescript: "tsx", javascript: "jsx", python: "python", go: "go", rust: "rust", json: "json", yaml: "yaml", markdown: "markdown", css: "css", sql: "sql", shell: "bash", html: "markup", diff: "diff" } as Record<string, string>)[language] ?? language;
  const hl = new Set(highlightLines);
  return (
    <Highlight theme={themes.github} code={code.replace(/\n$/, "")} language={lang}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre className="scroll-thin overflow-auto rounded-xl border border-line bg-[#FCFBF8] py-3 font-mono text-[12.5px] leading-[1.6]" style={{ maxHeight }}>
          {tokens.map((line, i) => {
            const n = i + startLine;
            const { className, ...lp } = getLineProps({ line });
            return (
              <div key={i} id={`L${n}`} {...lp} className={cx(className, "flex px-3", hl.has(n) && "bg-amber-soft/70 shadow-[inset_3px_0_0_var(--color-amber)]", onLineClick && "cursor-pointer hover:bg-ivory")} onClick={() => onLineClick?.(n)}>
                <span className="mr-4 inline-block w-10 shrink-0 select-none text-right text-faint">{n}</span>
                <span className="whitespace-pre">{line.map((t, k) => <span key={k} {...getTokenProps({ token: t })} />)}</span>
              </div>
            );
          })}
        </pre>
      )}
    </Highlight>
  );
}
export function DiffView({ diff, maxHeight = 560 }: { diff: string; maxHeight?: number }) {
  const lines = diff.split("\n");
  return (
    <pre className="scroll-thin overflow-auto rounded-xl border border-line bg-[#FCFBF8] py-2 font-mono text-[12px] leading-[1.55]" style={{ maxHeight }}>
      {lines.map((l, i) => (
        <div key={i} className={cx("px-3 whitespace-pre",
          l.startsWith("+") && !l.startsWith("+++") && "bg-success-soft/70 text-[#155d42]",
          l.startsWith("-") && !l.startsWith("---") && "bg-danger-soft/70 text-[#8c2a2a]",
          l.startsWith("@@") && "bg-info-soft/60 text-info",
          (l.startsWith("diff --git") || l.startsWith("commit ")) && "mt-2 border-t border-line pt-2 font-semibold text-ink")}>{l || " "}</div>
      ))}
    </pre>
  );
}
export function Markdown({ children }: { children: string }) {
  return <div className="prose-df"><ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown></div>;
}

// ---------------------------------------------------------------- Misc
export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cx("h-1.5 w-full overflow-hidden rounded-full bg-ivory ring-1 ring-line", className)}>
      <motion.div className="h-full rounded-full bg-gradient-to-r from-amber to-[#e8b55a]" initial={{ width: 0 }} animate={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} transition={{ duration: 0.4 }} />
    </div>
  );
}
/** Animated integer count-up (respects reduced motion). */
export function useCountUp(target: number | null, ms = 900) {
  const [v, setV] = useState<number | null>(target);
  const prev = useRef<number>(0);
  useEffect(() => {
    if (target == null) return setV(null);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return setV(target);
    const from = prev.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      setV(Math.round(from + (target - from) * e));
      if (k < 1) raf = requestAnimationFrame(step);
      else prev.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}
export function HealthRing({ score, size = 120, label = "Health", showGrade = false }: { score: number | null; size?: number; label?: string; showGrade?: boolean }) {
  const stroke = Math.max(8, Math.round(size / 15));
  const r = size / 2 - stroke - 4;
  const c = 2 * Math.PI * r;
  const v = score == null ? 0 : score / 100;
  const g = gradeFor(score);
  const shown = useCountUp(score);
  const id = useRef(`hr-${Math.random().toString(36).slice(2, 8)}`).current;
  const ticks = Array.from({ length: 40 }, (_, i) => i);
  return (
    <div className="relative" style={{ width: size, height: size }} role="img" aria-label={`${label} score ${score ?? "not available"}${score != null ? `, grade ${g.grade}` : ""}`}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={g.color} stopOpacity={0.75} />
            <stop offset="1" stopColor={g.color} />
          </linearGradient>
        </defs>
        {size >= 140 && ticks.map((i) => {
          const a = (i / ticks.length) * Math.PI * 2;
          const r1 = size / 2 - 2, r2 = size / 2 - (i % 5 === 0 ? 6 : 4);
          return <line key={i} x1={size / 2 + Math.cos(a) * r1} y1={size / 2 + Math.sin(a) * r1} x2={size / 2 + Math.cos(a) * r2} y2={size / 2 + Math.sin(a) * r2} stroke={i / ticks.length <= v ? g.color : "#E2DED5"} strokeOpacity={i / ticks.length <= v ? 0.55 : 1} strokeWidth={1} />;
        })}
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#EFECE5" strokeWidth={stroke} fill="none" />
        <motion.circle cx={size / 2} cy={size / 2} r={r} stroke={`url(#${id})`} strokeWidth={stroke} strokeLinecap="round" fill="none" strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - v) }} transition={{ duration: 1, ease: "easeOut" }} style={{ filter: score != null ? `drop-shadow(0 0 6px ${g.color}55)` : undefined }} />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="font-semibold tabular-nums tracking-[-0.03em] text-ink" style={{ fontSize: Math.round(size / 4.6) }}>{shown ?? "—"}</div>
          <div className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted">{label}</div>
          {showGrade && score != null && <div className="mx-auto mt-1 w-fit rounded-full px-2 py-0.5 text-[10.5px] font-semibold" style={{ background: `${g.color}18`, color: g.color }}>Grade {g.grade} · {g.label}</div>}
        </div>
      </div>
    </div>
  );
}
export function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}
export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cx("scroll-thin overflow-x-auto", className)}>
      <table className="w-full text-left text-[13px]">
        <thead><tr className="border-b border-line text-[11.5px] uppercase tracking-[0.06em] text-muted">{head.map((h, i) => <th key={i} className="px-4 py-2.5 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-line-2">{children}</tbody>
      </table>
    </div>
  );
}

import { titleCase } from "./format";

/** Human-readable one-liners for realtime events (Live Ops stream). */
export type Ev = { type: string; at: string; [k: string]: any };
export const EVENT_TONE: Record<string, "amber" | "success" | "danger" | "info" | "neutral" | "dark"> = { job: "info", scan: "amber", health: "success", gate: "dark", watch: "info", webhook: "info", notification: "amber", activity: "neutral", presence: "neutral", rag: "info", quantum: "dark", advisory: "danger" };

export function describeEvent(e: Ev): string {
  switch (e.type) {
    case "job": return `${e.jobType ?? "job"} ${e.status}${e.progress != null && e.status === "running" ? ` · ${Math.round(e.progress * 100)}%` : ""}${e.message ? ` — ${e.message}` : ""}`;
    case "job.log": return e.message;
    case "scan": return `${e.kind} scan ${e.status}`;
    case "health": return `Health score ${e.score}${e.delta != null ? ` (${e.delta >= 0 ? "+" : ""}${e.delta})` : ""}`;
    case "gate": return e.passed ? "Quality gate passed" : `Quality gate failed: ${(e.failed ?? []).join(", ")}`;
    case "watch": return `Remote check: ${e.status}${e.remoteSha ? ` @ ${String(e.remoteSha).slice(0, 8)}` : ""}${e.error ? ` — ${e.error}` : ""}`;
    case "webhook": return `Webhook ${e.event || ""} ${e.status}`;
    case "repository": return `Repository ${e.status ?? "updated"}`;
    case "rag": return `Copilot: ${e.phase}${e.phase === "done" && e.totalMs ? ` in ${(e.totalMs / 1000).toFixed(1)} s` : ""}`;
    case "rag.index": return `Semantic index rebuilt (${e.chunks} chunks)`;
    case "quantum": return e.done ? (e.error ? `Fix optimizer failed: ${e.error}` : "Fix optimizer finished") : `Annealing sweep ${e.sweep} · Γ=${e.gamma} · best ${e.bestValue}`;
    case "advisory": return e.status === "ok" ? (e.added ? `${e.added} new vulnerability advisor${e.added === 1 ? "y" : "ies"}` : "Advisory check: no change") : `Advisory check ${e.status}`;
    case "presence": return `${(e.users ?? []).length} online`;
    case "notification": return e.title;
    case "activity": return titleCase(String(e.action ?? "").replace(/\./g, " "));
    default: return titleCase(e.type);
  }
}


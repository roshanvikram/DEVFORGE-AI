export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEV_COLOR: Record<string, string> = {
  critical: "#B4232C",
  high: "#D94C4C",
  medium: "#D99A28",
  low: "#6B7F96",
  info: "#A3A199",
};

export function timeAgo(iso?: string | null): string {
  if (!iso) return "—";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
export const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
export const num = (n?: number | null) => (n == null ? "—" : n.toLocaleString());
export const pct = (n?: number | null) => (n == null ? "—" : `${Math.round(n)}%`);
export function duration(ms?: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
export function durationBetween(a?: string | null, b?: string | null) {
  if (!a || !b) return "—";
  return duration(Date.parse(b) - Date.parse(a));
}
export const titleCase = (s: string) => s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
export const usd = (n?: number | null) => (n == null ? "—" : `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`);

export const LANG_COLOR: Record<string, string> = {
  typescript: "#3B6EA8", javascript: "#D1B23C", python: "#3E7CB1", go: "#3BA7B5", rust: "#B7634A", java: "#B5764A", ruby: "#A8423C",
  php: "#6E6FA8", markdown: "#8B8A84", json: "#9C9A93", yaml: "#A39A83", css: "#6A5ACD", html: "#D06A3A", shell: "#5A7A50", sql: "#8A6FA0",
};

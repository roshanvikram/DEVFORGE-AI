/** Structured logger that redacts secret-looking values before they reach stdout. */
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /((?:password|secret|token|api[_-]?key)["'=: ]{1,3})[^\s"',}]{6,}/gi,
];
export function redact(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (_m, pre) => (typeof pre === "string" ? `${pre}[REDACTED]` : "[REDACTED]"));
  return out;
}
function out(level: string, msg: string, meta?: Record<string, unknown>) {
  if (process.env.VITEST && level !== "error") return;
  const payload = { t: new Date().toISOString(), level, msg, ...(meta ?? {}) };
  const line = redact(JSON.stringify(payload));
  if (level === "error") console.error(line);
  else console.log(line);
}
export const log = {
  info: (m: string, meta?: Record<string, unknown>) => out("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => out("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => out("error", m, meta),
};

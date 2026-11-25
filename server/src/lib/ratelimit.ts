import type { Request, Response, NextFunction } from "express";
import { tooMany } from "./errors.js";

type Bucket = { count: number; reset: number };
const buckets = new Map<string, Bucket>();

/** Fixed-window in-memory limiter. Returns true when the call is allowed. */
export function hit(key: string, limit: number, windowMs: number): boolean {
  const t = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < t) {
    buckets.set(key, { count: 1, reset: t + windowMs });
    return true;
  }
  b.count++;
  return b.count <= limit;
}
export function resetLimits() {
  buckets.clear();
}
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k);
}, 60_000).unref();

export const rateLimit = (name: string, limit: number, windowMs: number) => (req: Request, _res: Response, next: NextFunction) => {
  const who = (req as any).user?.id ?? req.ip;
  if (!hit(`${name}:${who}`, limit, windowMs)) return next(tooMany());
  next();
};

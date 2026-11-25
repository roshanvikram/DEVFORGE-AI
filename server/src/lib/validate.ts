import { z } from "zod";
import { badRequest } from "./errors.js";

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw badRequest(issues[0] ? `${issues[0].path ? issues[0].path + ": " : ""}${issues[0].message}` : "Invalid input", issues);
  }
  return r.data;
}

export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(200)
  .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), "Password must include letters and numbers");
export const id = z.string().min(3).max(64).regex(/^[A-Za-z0-9_]+$/);
export const pagination = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0) });

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";

import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { PROJECT_ROOT, config } from "./config.js";
import { HttpError } from "./lib/errors.js";
import { log } from "./lib/logger.js";
import { loadSession, csrfGuard } from "./auth/session.js";
import { authRouter } from "./auth/routes.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { reposRouter } from "./routes/repositories.js";
import { findingsRouter } from "./routes/findings.js";
import { jobsRouter } from "./routes/jobs.js";
import { platformRouter } from "./routes/platform.js";
import { realtimeRouter, hooksRouter } from "./routes/realtime.js";
import { intelligenceRouter } from "./routes/intelligence.js";
import "./workflows/engine.js";
import { rateLimit } from "./lib/ratelimit.js";

// Register background job handlers.
import "./services/analysis.js";
import "./services/testforge.js";
import "./services/investigations.js";
import "./services/reviews.js";
import "./services/rag.js";
import "./services/quantum.js";
import "./services/advisories.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (config.isProd) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });
  // Keep the raw body so webhook signatures can be verified byte-for-byte.
  app.use(express.json({ limit: "2mb", verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
  app.use(cookieParser());
  app.use(loadSession);
  // Server-to-server webhooks authenticate by HMAC signature, not cookies, so they sit before the CSRF guard.
  app.use("/api/hooks", rateLimit("hooks", 120, 60_000), hooksRouter);
  app.use("/api", csrfGuard);
  app.use("/api", rateLimit("api", 600, 60_000));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true, version: "0.1.0" }));
  app.use("/api/auth", authRouter);
  app.use("/api", workspacesRouter);
  app.use("/api/repositories", reposRouter);
  app.use("/api/findings", findingsRouter);
  app.use("/api", jobsRouter);
  app.use("/api", platformRouter);
  app.use("/api", realtimeRouter);
  app.use("/api", intelligenceRouter);
  app.use("/api", (_req, _res, next) => next(new HttpError(404, "API route not found", "not_found")));

  // Serve the built frontend in production.
  const dist = path.join(PROJECT_ROOT, "web", "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) return res.status(400).json({ error: { code: "bad_request", message: err.issues[0]?.message ?? "Invalid input" } });
    if ((err as any)?.type === "entity.parse.failed") return res.status(400).json({ error: { code: "bad_request", message: "Malformed JSON body" } });
    if ((err as any)?.type === "entity.too.large") return res.status(413).json({ error: { code: "too_large", message: "Request body too large" } });
    log.error("unhandled error", { path: req.path, error: String((err as any)?.stack ?? err) });
    res.status(500).json({ error: { code: "internal", message: "Internal server error" } });
  });
  return app;
}

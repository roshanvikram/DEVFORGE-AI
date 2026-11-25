import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db/db.js";
import { getSecret, getSettings } from "../services/integrations.js";
import { hit } from "../lib/ratelimit.js";
import { HttpError, unavailable } from "../lib/errors.js";
import { config } from "../config.js";
import { redact } from "../lib/logger.js";

/**
 * AI provider abstraction. Claude is the primary (and currently only) provider; other providers can
 * implement `AIProvider` and be returned from `providerFor()` without changes to callers.
 */
export type AIMessage = Anthropic.Beta.Messages.BetaMessageParam;
export type AITool = Anthropic.Beta.Messages.BetaTool;
export type AIContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

export interface AIRequest {
  feature: string;
  system: string;
  messages: AIMessage[];
  tools?: AITool[];
  maxTokens?: number;
  /** JSON schema for structured output (objects must set additionalProperties:false) */
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}
export interface AIResponse {
  content: AIContentBlock[];
  text: string;
  stopReason: string | null;
  usage: { input: number; output: number; costUsd: number };
  model: string;
}
export interface AIProvider {
  id: string;
  model: string;
  complete(req: AIRequest): Promise<AIResponse>;
}

const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-fable-5-2": [8, 40],
  "claude-opus-4-8": [5, 25],
};
export const SUPPORTED_MODELS = Object.keys(PRICES);

export class AINotConfiguredError extends HttpError {
  constructor() {
    super(503, "No AI provider is configured. Add an Anthropic API key in Settings → AI Providers (or set ANTHROPIC_API_KEY on the server).", "ai_not_configured");
  }
}

function apiKeyFor(workspaceId: string): { key: string; source: "workspace" | "environment" } | null {
  const ws = getSecret(workspaceId, "anthropic");
  if (ws) return { key: ws, source: "workspace" };
  if (process.env.ANTHROPIC_API_KEY) return { key: process.env.ANTHROPIC_API_KEY, source: "environment" };
  return null;
}

export function aiStatus(workspaceId: string) {
  const k = apiKeyFor(workspaceId);
  const s = getSettings(workspaceId);
  const month = new Date().toISOString().slice(0, 7);
  const spend = db().prepare(`SELECT COALESCE(SUM(cost_usd),0) AS c, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, COUNT(*) AS n FROM ai_usage WHERE workspace_id = ? AND substr(created_at,1,7) = ?`).get(workspaceId, month) as any;
  return { configured: !!k, source: k?.source ?? null, provider: "anthropic", model: s.ai.model, effort: s.ai.effort, monthSpendUsd: spend.c, monthInputTokens: spend.i, monthOutputTokens: spend.o, monthRequests: spend.n, budgetUsd: s.ai.monthlyBudgetUsd };
}

class ClaudeProvider implements AIProvider {
  id = "anthropic";
  private client: Anthropic;
  constructor(apiKey: string, public model: string, private effort: string, private workspaceId: string, private userId: string | null) {
    this.client = new Anthropic({
      apiKey,
      baseURL: process.env.DEVFORGE_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      timeout: config.ai.timeoutMs,
      maxRetries: 2,
    });
  }

  async complete(req: AIRequest): Promise<AIResponse> {
    const started = Date.now();
    const params: any = {
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: req.messages,
      output_config: { effort: this.effort, ...(req.jsonSchema ? { format: { type: "json_schema", schema: req.jsonSchema } } : {}) },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
    if (req.tools?.length) params.tools = req.tools;
    try {
      const stream = this.client.beta.messages.stream(params, { signal: req.signal });
      if (req.onText) stream.on("text", (t: string) => req.onText!(t));
      const msg = await stream.finalMessage();
      const input = (msg.usage.input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0);
      const output = msg.usage.output_tokens ?? 0;
      const [pi, po] = PRICES[msg.model] ?? PRICES[this.model] ?? [0, 0];
      const cost = ((msg.usage.input_tokens ?? 0) * pi + (msg.usage.cache_creation_input_tokens ?? 0) * pi * 1.25 + (msg.usage.cache_read_input_tokens ?? 0) * pi * 0.1 + output * po) / 1_000_000;
      this.record(req.feature, msg.model, input, output, cost, true, null, Date.now() - started);
      if (msg.stop_reason === "refusal") {
        throw new HttpError(422, "The AI model declined this request.", "ai_refusal");
      }
      const text = msg.content.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
      return { content: msg.content, text, stopReason: msg.stop_reason, usage: { input, output, costUsd: cost }, model: msg.model };
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      const status = e?.status as number | undefined;
      const message = redact(String(e?.message ?? e)).slice(0, 300);
      this.record(req.feature, this.model, 0, 0, 0, false, message, Date.now() - started);
      if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, "The configured Anthropic API key was rejected. Update it in Settings → AI Providers.", "ai_auth");
      // The key is valid but the Anthropic account has no usable credit.
      if (status === 400 && /credit balance is too low/i.test(String(e?.message))) throw new HttpError(402, "Your Anthropic account has no remaining API credit. Add credits in the Claude Console (Plans & Billing), then retry.", "ai_billing");
      if (e instanceof Anthropic.PermissionDeniedError) throw new HttpError(502, "The Anthropic API key does not have permission for this request (check the key's workspace and model access).", "ai_permission");
      if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "The AI provider is rate-limiting requests. Try again shortly.", "ai_rate_limited");
      if (e instanceof Anthropic.APIConnectionTimeoutError) throw new HttpError(504, "The AI request timed out.", "ai_timeout");
      if (e instanceof Anthropic.APIConnectionError) throw new HttpError(502, "Could not reach the AI provider.", "ai_unreachable");
      if (e?.name === "AbortError" || req.signal?.aborted) throw new Error("cancelled");
      throw new HttpError(502, `AI request failed${status ? ` (${status})` : ""}: ${message}`, "ai_error");
    }
  }

  private record(feature: string, model: string, input: number, output: number, cost: number, ok: boolean, error: string | null, ms: number) {
    db().prepare(`INSERT INTO ai_usage (workspace_id, user_id, feature, model, input_tokens, output_tokens, cost_usd, ok, error, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(this.workspaceId, this.userId, feature, model, input, output, cost, ok ? 1 : 0, error, ms);
  }
}

/** Returns the configured provider for a workspace, or null when no credentials are available. */
export function providerFor(workspaceId: string, userId: string | null): AIProvider | null {
  const k = apiKeyFor(workspaceId);
  if (!k) return null;
  const s = getSettings(workspaceId);
  return new ClaudeProvider(k.key, SUPPORTED_MODELS.includes(s.ai.model) ? s.ai.model : config.ai.model, s.ai.effort, workspaceId, userId);
}

/** Provider + guardrails (rate limit, monthly budget). Throws AINotConfiguredError when unavailable. */
export function requireProvider(workspaceId: string, userId: string | null): AIProvider {
  const p = providerFor(workspaceId, userId);
  if (!p) throw new AINotConfiguredError();
  if (!hit(`ai:${workspaceId}`, Number(process.env.AI_RATE_PER_MIN ?? 30), 60_000)) throw new HttpError(429, "AI rate limit for this workspace reached; try again in a minute.", "ai_rate_limited");
  const st = aiStatus(workspaceId);
  if (st.budgetUsd > 0 && st.monthSpendUsd >= st.budgetUsd) throw unavailable(`Monthly AI budget of $${st.budgetUsd} reached. Raise it in Settings → AI Providers.`, "ai_budget");
  return p;
}

/** Parse JSON from a structured-output response, tolerating code fences. */
export function parseJson<T>(text: string): T {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(t) as T;
}

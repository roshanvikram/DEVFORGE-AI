import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db/db.js";
import { getSecret, getSettings } from "../services/integrations.js";
import { hit } from "../lib/ratelimit.js";
import { HttpError, unavailable } from "../lib/errors.js";
import { config } from "../config.js";
import { redact } from "../lib/logger.js";

/**
 * AI provider abstraction. Callers speak one message/tool format (Anthropic-shaped content blocks);
 * each provider translates it. Providers: Anthropic Claude (SDK, streaming) and Groq (OpenAI-compatible
 * chat completions). The workspace chooses one, or "auto" (Claude if configured, else Groq).
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
  id: "anthropic" | "groq";
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
/** Groq production models usable for chat + tool calling. Cost is only tracked when GROQ_PRICES is set. */
export const GROQ_MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"];
export type ProviderChoice = "auto" | "anthropic" | "groq";

export class AINotConfiguredError extends HttpError {
  constructor() {
    super(503, "No AI provider is configured. Connect Anthropic (Claude) or Groq in Integrations (or set ANTHROPIC_API_KEY / GROQ_API_KEY on the server).", "ai_not_configured");
  }
}

function apiKeyFor(workspaceId: string, provider: "anthropic" | "groq" = "anthropic"): { key: string; source: "workspace" | "environment" } | null {
  const ws = getSecret(workspaceId, provider);
  if (ws) return { key: ws, source: "workspace" };
  const env = provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.GROQ_API_KEY;
  if (env) return { key: env, source: "environment" };
  return null;
}

/** Resolves which provider a workspace uses right now, honouring its choice and available keys. */
function resolveProvider(workspaceId: string): { id: "anthropic" | "groq"; key: string; source: "workspace" | "environment" } | null {
  const choice = (getSettings(workspaceId).ai as any).provider as ProviderChoice | undefined;
  const order: ("anthropic" | "groq")[] = choice === "groq" ? ["groq"] : choice === "anthropic" ? ["anthropic"] : ["anthropic", "groq"];
  for (const id of order) {
    const k = apiKeyFor(workspaceId, id);
    if (k) return { id, ...k };
  }
  return null;
}

function groqModel(workspaceId: string) {
  const m = (getSettings(workspaceId).ai as any).groqModel as string | undefined;
  return m && GROQ_MODELS.includes(m) ? m : GROQ_MODELS[0];
}

/** Optional Groq pricing (USD per million tokens), e.g. GROQ_PRICES="llama-3.3-70b-versatile=0.59/0.79;openai/gpt-oss-20b=0.1/0.5". */
function groqPrice(model: string): [number, number] | null {
  for (const part of (process.env.GROQ_PRICES ?? "").split(";")) {
    const [m, v] = part.split("=");
    if (m?.trim() === model && v) {
      const [i, o] = v.split("/").map(Number);
      if (Number.isFinite(i) && Number.isFinite(o)) return [i, o];
    }
  }
  return null;
}

export function aiStatus(workspaceId: string) {
  const p = resolveProvider(workspaceId);
  const s = getSettings(workspaceId);
  const month = new Date().toISOString().slice(0, 7);
  const spend = db().prepare(`SELECT COALESCE(SUM(cost_usd),0) AS c, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, COUNT(*) AS n FROM ai_usage WHERE workspace_id = ? AND substr(created_at,1,7) = ?`).get(workspaceId, month) as any;
  const model = p?.id === "groq" ? groqModel(workspaceId) : s.ai.model;
  return {
    configured: !!p, source: p?.source ?? null, provider: p?.id ?? null, choice: ((s.ai as any).provider ?? "auto") as ProviderChoice, model, effort: s.ai.effort,
    costTracked: p?.id !== "groq" || !!groqPrice(model),
    available: { anthropic: !!apiKeyFor(workspaceId, "anthropic"), groq: !!apiKeyFor(workspaceId, "groq") },
    monthSpendUsd: spend.c, monthInputTokens: spend.i, monthOutputTokens: spend.o, monthRequests: spend.n, budgetUsd: s.ai.monthlyBudgetUsd,
  };
}

function recordUsage(workspaceId: string, userId: string | null, feature: string, model: string, input: number, output: number, cost: number, ok: boolean, error: string | null, ms: number) {
  db().prepare(`INSERT INTO ai_usage (workspace_id, user_id, feature, model, input_tokens, output_tokens, cost_usd, ok, error, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(workspaceId, userId, feature, model, input, output, cost, ok ? 1 : 0, error, ms);
}

class ClaudeProvider implements AIProvider {
  id = "anthropic" as const;
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
    recordUsage(this.workspaceId, this.userId, feature, model, input, output, cost, ok, error, ms);
  }
}

type OAMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: any[]; tool_call_id?: string };

/** Groq via its OpenAI-compatible Chat Completions API. Translates DevForge's Anthropic-shaped messages/tools. */
class GroqProvider implements AIProvider {
  id = "groq" as const;
  constructor(private apiKey: string, public model: string, private workspaceId: string, private userId: string | null) {}

  private toMessages(system: string, messages: AIMessage[]): OAMessage[] {
    const out: OAMessage[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (typeof m.content === "string") {
        out.push({ role: m.role, content: m.content });
        continue;
      }
      const blocks = m.content as any[];
      if (m.role === "assistant") {
        const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
        const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
        out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      } else {
        for (const b of blocks) {
          if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
        }
        const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
        if (text) out.push({ role: "user", content: text });
      }
    }
    return out;
  }

  async complete(req: AIRequest): Promise<AIResponse> {
    const started = Date.now();
    let system = req.system;
    if (req.jsonSchema) system += `\n\nRespond with a single JSON object (no prose, no code fences) that validates against this JSON Schema:\n${JSON.stringify(req.jsonSchema)}`;
    const body: any = { model: this.model, messages: this.toMessages(system, req.messages), max_completion_tokens: Math.min(req.maxTokens ?? 8000, 8000), temperature: 0.2 };
    if (req.tools?.length) {
      body.tools = req.tools.map((t: any) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
      body.tool_choice = "auto";
    }
    if (req.jsonSchema && !req.tools?.length) body.response_format = { type: "json_object" };
    const timeout = AbortSignal.timeout(config.ai.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${process.env.DEVFORGE_GROQ_BASE_URL ?? "https://api.groq.com"}/openai/v1/chat/completions`, {
        method: "POST", signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      this.record(req.feature, 0, 0, 0, false, redact(String(e?.message ?? e)).slice(0, 300), Date.now() - started);
      if (req.signal?.aborted) throw new Error("cancelled");
      if (timeout.aborted) throw new HttpError(504, "The AI request timed out.", "ai_timeout");
      throw new HttpError(502, "Could not reach Groq.", "ai_unreachable");
    }
    const data: any = await res.json().catch(() => null);
    if (!res.ok) {
      const message = redact(String(data?.error?.message ?? res.statusText)).slice(0, 300);
      this.record(req.feature, 0, 0, 0, false, `${res.status}: ${message}`, Date.now() - started);
      if (res.status === 401) throw new HttpError(502, "The configured Groq API key was rejected. Update it in Integrations → Groq.", "ai_auth");
      if (res.status === 403) throw new HttpError(502, "The Groq API key does not have permission for this request.", "ai_permission");
      if (res.status === 429) throw new HttpError(429, "Groq is rate-limiting requests (or the account's quota is used up). Try again shortly.", "ai_rate_limited");
      if (res.status === 413) throw new HttpError(502, "The request was too large for the selected Groq model. Pick a model with a larger context window or reduce context files.", "ai_too_large");
      throw new HttpError(502, `Groq request failed (${res.status}): ${message}`, "ai_error");
    }
    const choice = data?.choices?.[0];
    const msg = choice?.message ?? {};
    const content: any[] = [];
    if (msg.content) content.push({ type: "text", text: msg.content, citations: null });
    for (const c of msg.tool_calls ?? []) {
      let input: unknown = {};
      try { input = JSON.parse(c.function?.arguments || "{}"); } catch { input = {}; }
      content.push({ type: "tool_use", id: c.id, name: c.function?.name, input });
    }
    const input = data?.usage?.prompt_tokens ?? 0;
    const output = data?.usage?.completion_tokens ?? 0;
    const price = groqPrice(this.model);
    const cost = price ? (input * price[0] + output * price[1]) / 1_000_000 : 0;
    this.record(req.feature, input, output, cost, true, null, Date.now() - started);
    const text = msg.content ?? "";
    if (text && req.onText) req.onText(text);
    const stop = choice?.finish_reason === "tool_calls" ? "tool_use" : choice?.finish_reason === "length" ? "max_tokens" : "end_turn";
    return { content: content as AIContentBlock[], text, stopReason: stop, usage: { input, output, costUsd: cost }, model: data?.model ?? this.model };
  }

  private record(feature: string, input: number, output: number, cost: number, ok: boolean, error: string | null, ms: number) {
    recordUsage(this.workspaceId, this.userId, feature, `groq:${this.model}`, input, output, cost, ok, error, ms);
  }
}

/** Returns the workspace's active provider, or null when no credentials are available. */
export function providerFor(workspaceId: string, userId: string | null): AIProvider | null {
  const p = resolveProvider(workspaceId);
  if (!p) return null;
  const s = getSettings(workspaceId);
  if (p.id === "groq") return new GroqProvider(p.key, groqModel(workspaceId), workspaceId, userId);
  return new ClaudeProvider(p.key, SUPPORTED_MODELS.includes(s.ai.model) ? s.ai.model : config.ai.model, s.ai.effort, workspaceId, userId);
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

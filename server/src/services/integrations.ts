import { db, now, json } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { encryptSecret, decryptSecret, last4 } from "../lib/crypto.js";

export const INTEGRATION_PROVIDERS = {
  github: { name: "GitHub", secretLabel: "Personal access token (repo, read:org)", description: "Import private repositories, list pull requests, post review comments." },
  anthropic: { name: "Anthropic (Claude)", secretLabel: "API key (starts with sk-ant-api…)", description: "AI provider for agents, investigations, reviews, test generation and Q&A." },
  groq: { name: "Groq", secretLabel: "API key (starts with gsk_…)", description: "Fast open-model inference (Llama, GPT-OSS) as an alternative AI provider." },
  slack: { name: "Slack", secretLabel: "Incoming webhook URL", description: "Send workflow notifications to a Slack channel." },
  webhook: { name: "Generic webhook", secretLabel: "Webhook URL (https)", description: "POST workflow notifications as JSON to your endpoint." },
} as const;
export type Provider = keyof typeof INTEGRATION_PROVIDERS;

export function listIntegrations(workspaceId: string) {
  const rows = db().prepare(`SELECT provider, status, config, secret_last4, updated_at FROM integrations WHERE workspace_id = ?`).all(workspaceId) as any[];
  const byP = new Map(rows.map((r) => [r.provider, r]));
  return (Object.keys(INTEGRATION_PROVIDERS) as Provider[]).map((p) => {
    const r = byP.get(p);
    const envConfigured = p === "anthropic" ? !!process.env.ANTHROPIC_API_KEY : p === "groq" ? !!process.env.GROQ_API_KEY : p === "github" ? !!process.env.GITHUB_TOKEN : false;
    return {
      provider: p,
      ...INTEGRATION_PROVIDERS[p],
      status: r?.status === "connected" ? "connected" : envConfigured ? "connected" : "disconnected",
      source: r?.status === "connected" ? "workspace" : envConfigured ? "environment" : null,
      secretHint: r?.secret_last4 ? `••••${r.secret_last4}` : null,
      config: json(r?.config, {}),
      updatedAt: r?.updated_at ?? null,
    };
  });
}

export function setIntegration(workspaceId: string, provider: Provider, secret: string | null, cfg: Record<string, unknown>, userId: string) {
  const enc = secret ? encryptSecret(secret) : null;
  db()
    .prepare(
      `INSERT INTO integrations (id, workspace_id, provider, status, config, secret_enc, secret_last4, created_by) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(workspace_id, provider) DO UPDATE SET status = excluded.status, config = excluded.config,
         secret_enc = COALESCE(excluded.secret_enc, integrations.secret_enc), secret_last4 = COALESCE(excluded.secret_last4, integrations.secret_last4), updated_at = ?`,
    )
    .run(newId("int_"), workspaceId, provider, "connected", JSON.stringify(cfg), enc, secret ? last4(secret) : null, userId, now());
}

export function removeIntegration(workspaceId: string, provider: Provider) {
  db().prepare(`DELETE FROM integrations WHERE workspace_id = ? AND provider = ?`).run(workspaceId, provider);
}

export function getSecret(workspaceId: string, provider: Provider): string | null {
  const r = db().prepare(`SELECT secret_enc FROM integrations WHERE workspace_id = ? AND provider = ? AND status = 'connected'`).get(workspaceId, provider) as any;
  return decryptSecret(r?.secret_enc);
}

export function getIntegrationConfig(workspaceId: string, provider: Provider): Record<string, any> {
  const r = db().prepare(`SELECT config FROM integrations WHERE workspace_id = ? AND provider = ?`).get(workspaceId, provider) as any;
  return json(r?.config, {});
}

/** GitHub token: workspace PAT > environment GITHUB_TOKEN > a member's GitHub OAuth token. */
export function getGithubToken(workspaceId: string): string | null {
  const ws = getSecret(workspaceId, "github");
  if (ws) return ws;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const oa = db()
    .prepare(`SELECT o.access_token_enc FROM oauth_accounts o JOIN memberships m ON m.user_id = o.user_id WHERE m.workspace_id = ? AND o.provider = 'github' AND o.scope LIKE '%repo%' ORDER BY m.role = 'owner' DESC LIMIT 1`)
    .get(workspaceId) as any;
  return decryptSecret(oa?.access_token_enc);
}

// ---------- workspace settings ----------
export const DEFAULT_SETTINGS = {
  ai: { provider: "auto" as "auto" | "anthropic" | "groq", model: "claude-opus-5-5", groqModel: "llama-3.3-70b-versatile", effort: "medium" as "low" | "medium" | "high" | "xhigh" | "max", maxContextFiles: 12, monthlyBudgetUsd: 50, allowCodeSnippetsToAI: true },
  analysis: { defaultPreset: "quick", osv: true },
  notifications: { analysisComplete: true, criticalFindings: true, workflowApprovals: true, email: false },
  retention: { activityDays: 365, jobLogDays: 90, chatDays: 180 },
};

export function getSettings(workspaceId: string): typeof DEFAULT_SETTINGS {
  const r = db().prepare(`SELECT data FROM workspace_settings WHERE workspace_id = ?`).get(workspaceId) as any;
  const s = json<any>(r?.data, {});
  return {
    ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai ?? {}) },
    analysis: { ...DEFAULT_SETTINGS.analysis, ...(s.analysis ?? {}) },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(s.notifications ?? {}) },
    retention: { ...DEFAULT_SETTINGS.retention, ...(s.retention ?? {}) },
  };
}

export function updateSettings(workspaceId: string, patch: Partial<typeof DEFAULT_SETTINGS>) {
  const cur = getSettings(workspaceId);
  const next = {
    ai: { ...cur.ai, ...(patch.ai ?? {}) },
    analysis: { ...cur.analysis, ...(patch.analysis ?? {}) },
    notifications: { ...cur.notifications, ...(patch.notifications ?? {}) },
    retention: { ...cur.retention, ...(patch.retention ?? {}) },
  };
  db().prepare(`INSERT INTO workspace_settings (workspace_id, data, updated_at) VALUES (?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run(workspaceId, JSON.stringify(next), now());
  return next;
}

-- Performance: indexes for the hot repository-scoped queries (health score, dashboard, trends).
CREATE INDEX IF NOT EXISTS idx_findings_repo_status ON findings(repository_id, review_id, status, source, severity);
CREATE INDEX IF NOT EXISTS idx_findings_repo_first_seen ON findings(repository_id, first_seen_at);
CREATE INDEX IF NOT EXISTS idx_findings_repo_resolved ON findings(repository_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_test_runs_repo ON test_runs(repository_id, created_at);
CREATE INDEX IF NOT EXISTS idx_investigations_repo ON investigations(repository_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_ws_status ON jobs(workspace_id, status, finished_at);

-- Feature: health score history (one row per completed analysis, never estimated).
CREATE TABLE health_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  snapshot_id TEXT,
  commit_sha TEXT,
  score INTEGER NOT NULL,
  reliability INTEGER NOT NULL,
  security INTEGER NOT NULL,
  performance INTEGER NOT NULL,
  maintainability INTEGER NOT NULL,
  open_findings INTEGER NOT NULL,
  critical INTEGER NOT NULL,
  high INTEGER NOT NULL,
  loc INTEGER,
  trigger TEXT NOT NULL DEFAULT 'analysis',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_health_history_repo ON health_history(repository_id, created_at);

-- Feature: quality gates (one policy per workspace) and their evaluations.
CREATE TABLE quality_gates (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  min_score INTEGER,
  max_critical INTEGER,
  max_high INTEGER,
  max_secrets INTEGER,
  max_vulnerable_deps INTEGER,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE gate_results (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  snapshot_id TEXT,
  passed INTEGER NOT NULL,
  checks TEXT NOT NULL,
  trigger TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_gate_results_repo ON gate_results(repository_id, created_at);
CREATE INDEX idx_gate_results_ws ON gate_results(workspace_id, created_at);

-- Feature: repository auto-sync (remote polling) and signed push webhooks.
ALTER TABLE repositories ADD COLUMN watch_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repositories ADD COLUMN watch_interval_min INTEGER NOT NULL DEFAULT 15;
ALTER TABLE repositories ADD COLUMN watch_preset TEXT NOT NULL DEFAULT 'quick';
ALTER TABLE repositories ADD COLUMN watch_last_checked_at TEXT;
ALTER TABLE repositories ADD COLUMN watch_remote_sha TEXT;
ALTER TABLE repositories ADD COLUMN watch_last_error TEXT;
ALTER TABLE repositories ADD COLUMN webhook_secret TEXT;
ALTER TABLE repositories ADD COLUMN webhook_last_delivery_at TEXT;

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  event TEXT,
  delivery_id TEXT,
  status TEXT NOT NULL,
  detail TEXT,
  job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_webhook_deliveries_repo ON webhook_deliveries(repository_id, created_at);

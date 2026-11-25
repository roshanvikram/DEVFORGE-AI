-- RAG: chunked, locally-embedded code for hybrid retrieval.
CREATE TABLE rag_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  symbol TEXT,
  text TEXT NOT NULL,
  vec BLOB NOT NULL
);
CREATE INDEX idx_rag_chunks_snapshot ON rag_chunks(snapshot_id, path);

CREATE TABLE rag_index (
  snapshot_id TEXT PRIMARY KEY REFERENCES snapshots(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  chunks INTEGER NOT NULL,
  files INTEGER NOT NULL,
  dims INTEGER NOT NULL,
  idf BLOB NOT NULL,
  build_ms INTEGER NOT NULL,
  built_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE rag_queries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  sources TEXT NOT NULL DEFAULT '[]',
  answer TEXT,
  citations TEXT NOT NULL DEFAULT '[]',
  provider TEXT,
  model TEXT,
  retrieval_ms INTEGER,
  total_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_rag_queries_repo ON rag_queries(repository_id, created_at);

-- Quantum-inspired fix-plan optimisation runs.
CREATE TABLE fix_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  params TEXT NOT NULL,
  result TEXT,
  job_id TEXT,
  error TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE INDEX idx_fix_plans_repo ON fix_plans(repository_id, created_at);

-- Advisory watch: scheduled OSV re-checks of existing dependencies.
CREATE TABLE advisory_checks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  packages INTEGER NOT NULL DEFAULT 0,
  advisories INTEGER NOT NULL DEFAULT 0,
  new_advisories TEXT NOT NULL DEFAULT '[]',
  resolved_advisories TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_advisory_checks_repo ON advisory_checks(repository_id, created_at);

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, "migrations");

export type DB = Database.Database;

let _db: DB | null = null;

export function openDb(file = config.dbPath): DB {
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  d.pragma("busy_timeout = 5000");
  d.pragma("synchronous = NORMAL");
  d.pragma("cache_size = -32000"); // 32 MB page cache
  d.pragma("temp_store = MEMORY");
  d.pragma("mmap_size = 268435456"); // 256 MB memory-mapped reads
  // Statement cache: the app re-prepares the same SQL on every request; compiling once is
  // markedly cheaper for hot paths (session lookup, membership checks, dashboards).
  const prepare = d.prepare.bind(d);
  const cache = new Map<string, Database.Statement>();
  (d as any).prepare = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = prepare(sql);
      if (cache.size > 2000) cache.clear();
      cache.set(sql, s);
    }
    return s;
  };
  return d;
}

export function migrate(d: DB): string[] {
  d.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(d.prepare(`SELECT name FROM _migrations`).all().map((r: any) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    d.transaction(() => {
      d.exec(sql);
      d.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(f, new Date().toISOString());
    })();
    ran.push(f);
  }
  return ran;
}

export function db(): DB {
  if (!_db) {
    _db = openDb();
    migrate(_db);
  }
  return _db;
}

export const now = () => new Date().toISOString();

export function json<T = any>(v: string | null | undefined, fallback: T): T {
  if (v == null) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

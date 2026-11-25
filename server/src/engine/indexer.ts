import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { db } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { config } from "../config.js";
import { detectLanguage, SKIP_DIRS, BINARY_EXT, isTestPath, isGenerated, CODE_LANGS } from "./languages.js";
import { parseTsFile } from "./parse-ts.js";
import type { IndexedFile, ParseResult, RawFinding } from "./types.js";
import { isManifest } from "./deps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PY_ANALYZER = path.join(here, "py_analyzer.py");

export interface IndexContext {
  snapshotId: string;
  root: string;
  files: IndexedFile[];
  parse: Map<string, ParseResult>;
  manifests: string[];
  frameworks: string[];
  indexFindings: RawFinding[];
}

type Log = (m: string) => void;
type Progress = (p: number, m?: string) => void;

function walk(root: string, log: Log): { rel: string; abs: string; size: number }[] {
  const out: { rel: string; abs: string; size: number }[] = [];
  const stack = [""];
  let skippedLarge = 0;
  while (stack.length) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue; // never follow symlinks out of the repo
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".git")) stack.push(r);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (BINARY_EXT.has(ext) || e.name.endsWith(".min.js")) continue;
      if (e.name === "package-lock.json" || e.name === "yarn.lock" || e.name === "pnpm-lock.yaml") {
        out.push({ rel: r, abs: path.join(root, r), size: fs.statSync(path.join(root, r)).size });
        continue;
      }
      const abs = path.join(root, r);
      const size = fs.statSync(abs).size;
      if (size > config.maxFileBytes) {
        skippedLarge++;
        continue;
      }
      out.push({ rel: r, abs, size });
      if (out.length >= config.maxIndexedFiles) {
        log(`File limit reached (${config.maxIndexedFiles}); remaining files are not indexed`);
        return out;
      }
    }
  }
  if (skippedLarge) log(`Skipped ${skippedLarge} files larger than ${Math.round(config.maxFileBytes / 1024)} KB`);
  return out;
}

function runPython(items: { path: string; abs: string; isTest: boolean }[], log: Log): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    if (!items.length) return resolve({});
    const child = spawn("python3", ["-I", PY_ANALYZER], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("error", () => {
      clearTimeout(timer);
      log("python3 is not available; Python files indexed without AST analysis");
      resolve({});
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        log(`Python analyzer failed: ${err.slice(0, 200)}`);
        resolve({});
      }
    });
    child.stdin.end(JSON.stringify(items));
  });
}

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"];

function makeResolver(paths: Set<string>, root: string) {
  // tsconfig "paths" aliases (best effort): read compilerOptions.paths from root tsconfig/jsconfig
  const aliases: [string, string][] = [];
  for (const cfgName of ["tsconfig.json", "jsconfig.json"]) {
    try {
      const txt = fs.readFileSync(path.join(root, cfgName), "utf8").replace(/\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
      const cfg = JSON.parse(txt);
      const base = cfg.compilerOptions?.baseUrl ?? ".";
      for (const [k, v] of Object.entries<string[]>(cfg.compilerOptions?.paths ?? {})) {
        if (k.endsWith("/*") && v[0]?.endsWith("/*")) aliases.push([k.slice(0, -1), path.posix.normalize(path.posix.join(base, v[0].slice(0, -1)))]);
      }
    } catch { /* none */ }
  }
  if (!aliases.length) aliases.push(["@/", "src/"], ["~/", "src/"]);

  const tryFile = (p: string): string | null => {
    const n = path.posix.normalize(p).replace(/^\.\//, "");
    if (paths.has(n)) return n;
    const noExt = n.replace(/\.(js|jsx|mjs|cjs)$/, "");
    for (const e of JS_EXTS) if (paths.has(noExt + e)) return noExt + e;
    for (const e of JS_EXTS) if (paths.has(`${n}/index${e}`)) return `${n}/index${e}`;
    return null;
  };

  return (fromFile: string, spec: string, lang: string | null): { file: string | null; external: string | null; relative: boolean } => {
    if (lang === "python") {
      if (spec.startsWith(".")) {
        const dots = spec.match(/^\.+/)![0].length;
        let base = path.posix.dirname(fromFile);
        for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
        const mod = spec.slice(dots).replace(/\./g, "/");
        const cand = mod ? `${base}/${mod}` : base;
        for (const c of [`${cand}.py`, `${cand}/__init__.py`]) {
          const n = path.posix.normalize(c).replace(/^\.\//, "");
          if (paths.has(n)) return { file: n, external: null, relative: true };
        }
        return { file: null, external: null, relative: true };
      }
      const mod = spec.replace(/\./g, "/");
      for (const prefix of ["", "src/", "app/", "lib/"]) {
        for (const c of [`${prefix}${mod}.py`, `${prefix}${mod}/__init__.py`]) if (paths.has(c)) return { file: c, external: null, relative: false };
      }
      return { file: null, external: spec.split(".")[0], relative: false };
    }
    if (spec.startsWith(".")) {
      return { file: tryFile(path.posix.join(path.posix.dirname(fromFile), spec)), external: null, relative: true };
    }
    for (const [prefix, target] of aliases) {
      if (spec.startsWith(prefix)) {
        const f = tryFile(target + spec.slice(prefix.length));
        if (f) return { file: f, external: null, relative: false };
      }
    }
    if (spec.startsWith("/")) return { file: tryFile(spec.slice(1)), external: null, relative: true };
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    return { file: null, external: pkg.replace(/^node:/, "node:"), relative: false };
  };
}

function detectFrameworks(root: string, manifests: string[], files: IndexedFile[]): string[] {
  const fw = new Set<string>();
  const add = (cond: boolean, name: string) => cond && fw.add(name);
  for (const m of manifests) {
    try {
      const text = fs.readFileSync(path.join(root, m), "utf8");
      if (m.endsWith("package.json")) {
        const j = JSON.parse(text);
        const all = { ...j.dependencies, ...j.devDependencies };
        const has = (n: string) => n in all;
        add(has("react"), "React"); add(has("next"), "Next.js"); add(has("vue"), "Vue"); add(has("nuxt"), "Nuxt"); add(has("svelte"), "Svelte"); add(has("@sveltejs/kit"), "SvelteKit");
        add(has("@angular/core"), "Angular"); add(has("express"), "Express"); add(has("fastify"), "Fastify"); add(has("koa"), "Koa"); add(has("hono"), "Hono"); add(has("@nestjs/core"), "NestJS");
        add(has("prisma") || has("@prisma/client"), "Prisma"); add(has("typeorm"), "TypeORM"); add(has("sequelize"), "Sequelize"); add(has("mongoose"), "Mongoose"); add(has("drizzle-orm"), "Drizzle");
        add(has("jest"), "Jest"); add(has("vitest"), "Vitest"); add(has("mocha"), "Mocha"); add(has("@playwright/test"), "Playwright"); add(has("cypress"), "Cypress");
        add(has("vite"), "Vite"); add(has("webpack"), "Webpack"); add(has("electron"), "Electron"); add(has("react-native"), "React Native"); add(has("tailwindcss"), "Tailwind CSS"); add(has("graphql"), "GraphQL");
        add(has("typescript"), "TypeScript");
      } else if (/requirements|pyproject|Pipfile/.test(m)) {
        const t = text.toLowerCase();
        add(/\bdjango\b/.test(t), "Django"); add(/\bflask\b/.test(t), "Flask"); add(/\bfastapi\b/.test(t), "FastAPI"); add(/sqlalchemy/.test(t), "SQLAlchemy");
        add(/\bpytest\b/.test(t), "Pytest"); add(/\bcelery\b/.test(t), "Celery"); add(/pydantic/.test(t), "Pydantic"); add(/\bstarlette\b/.test(t), "Starlette");
        add(/\btorch\b/.test(t), "PyTorch"); add(/tensorflow/.test(t), "TensorFlow"); add(/\bpandas\b/.test(t), "pandas");
      } else if (m.endsWith("go.mod")) {
        add(/gin-gonic/.test(text), "Gin"); add(/labstack\/echo/.test(text), "Echo"); add(/gofiber/.test(text), "Fiber"); fw.add("Go modules");
      } else if (m.endsWith("Cargo.toml")) {
        add(/actix-web/.test(text), "Actix"); add(/\baxum\b/.test(text), "Axum"); add(/\btokio\b/.test(text), "Tokio");
      }
    } catch { /* ignore */ }
  }
  add(files.some((f) => f.path.endsWith("Dockerfile")), "Docker");
  add(files.some((f) => /docker-compose\.ya?ml$/.test(f.path)), "Docker Compose");
  add(files.some((f) => f.path.startsWith(".github/workflows/")), "GitHub Actions");
  add(files.some((f) => f.path.endsWith(".tf")), "Terraform");
  add(files.some((f) => f.path.endsWith("schema.prisma")), "Prisma");
  return [...fw].sort();
}

/** Extra model discovery for schema files (Prisma / SQL / Django). */
function schemaModels(f: IndexedFile) {
  const out: { name: string; line: number; orm: string }[] = [];
  const lines = f.content.split("\n");
  if (f.language === "prisma") lines.forEach((l, i) => { const m = l.match(/^\s*model\s+(\w+)\s*\{/); if (m) out.push({ name: m[1], line: i + 1, orm: "prisma" }); });
  if (f.language === "sql") lines.forEach((l, i) => { const m = l.match(/create\s+table\s+(?:if\s+not\s+exists\s+)?[`"[]?(\w+)/i); if (m) out.push({ name: m[1], line: i + 1, orm: "sql" }); });
  return out;
}

export async function indexRepository(repoId: string, root: string, meta: { sha: string | null; branch: string | null }, log: Log, progress: Progress, signal?: AbortSignal): Promise<IndexContext> {
  const d = db();
  const snapshotId = newId("snp_");
  d.prepare(`INSERT INTO snapshots (id, repository_id, commit_sha, branch, status) VALUES (?,?,?,?, 'indexing')`).run(snapshotId, repoId, meta.sha, meta.branch);

  progress(0.05, "Discovering files");
  const walked = walk(root, log);
  log(`Discovered ${walked.length} files`);
  const files: IndexedFile[] = [];
  for (const w of walked) {
    let content: string;
    try {
      const buf = fs.readFileSync(w.abs);
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      content = buf.toString("utf8");
    } catch {
      continue;
    }
    if (isGenerated(w.rel, content) && !isManifest(w.rel)) continue;
    const language = detectLanguage(w.rel);
    const loc = content.split("\n").filter((l) => l.trim().length > 0).length;
    files.push({ id: newId("fil_"), path: w.rel, abs: w.abs, language, size: w.size, loc, content, isTest: isTestPath(w.rel) });
  }
  if (signal?.aborted) throw new Error("cancelled");

  progress(0.15, "Parsing source files");
  const parse = new Map<string, ParseResult>();
  let done = 0;
  for (const f of files) {
    if (f.language === "typescript" || f.language === "javascript") {
      if (f.path.endsWith(".json")) continue;
      try {
        parse.set(f.path, parseTsFile(f.path, f.content, f.isTest));
      } catch (e: any) {
        log(`Parse failed for ${f.path}: ${e.message}`);
      }
      if (++done % 200 === 0) {
        progress(0.15 + 0.25 * (done / files.length), `Parsed ${done} files`);
        await new Promise((r) => setImmediate(r));
        if (signal?.aborted) throw new Error("cancelled");
      }
    }
  }
  const pyFiles = files.filter((f) => f.language === "python");
  if (pyFiles.length) {
    progress(0.42, `Parsing ${pyFiles.length} Python files`);
    for (let i = 0; i < pyFiles.length; i += 400) {
      const res = await runPython(pyFiles.slice(i, i + 400).map((f) => ({ path: f.path, abs: f.abs, isTest: f.isTest })), log);
      for (const [p, r] of Object.entries(res)) {
        parse.set(p, { ...(r as any), findings: ((r as any).findings ?? []).map((x: any) => ({ ...x, file_path: p, snippet: x.snippet ?? files.find((f) => f.path === p)?.content.split("\n")[x.line - 1]?.trim().slice(0, 300) })) });
      }
    }
  }

  progress(0.5, "Building symbol index and dependency graph");
  const paths = new Set(files.map((f) => f.path));
  const resolve = makeResolver(paths, root);
  const fileIdByPath = new Map(files.map((f) => [f.path, f.id]));
  const indexFindings: RawFinding[] = [];

  const insFile = d.prepare(`INSERT INTO files (id, snapshot_id, path, language, size, loc, hash, complexity, max_function_lines, is_test, parsed) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insFts = d.prepare(`INSERT INTO code_fts (path, content, file_id, snapshot_id) VALUES (?,?,?,?)`);
  const insSym = d.prepare(`INSERT INTO symbols (id, snapshot_id, file_id, name, kind, parent, line, end_line, signature, exported, complexity, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insEdge = d.prepare(`INSERT INTO edges (snapshot_id, kind, source_file_id, source_symbol, target_file_id, target_symbol, target_external, line) VALUES (?,?,?,?,?,?,?,?)`);

  // symbol name -> [file paths] for call resolution
  const symbolFiles = new Map<string, string[]>();
  for (const [p, r] of parse) for (const s of r.symbols) if (s.kind === "function" || s.kind === "method" || s.kind === "class" || s.kind === "component") {
    const key = s.name;
    if (!symbolFiles.has(key)) symbolFiles.set(key, []);
    symbolFiles.get(key)!.push(p);
  }

  d.transaction(() => {
    // Insert every file first so import/call edges can reference any target file.
    for (const f of files) {
      const r = parse.get(f.path);
      insFile.run(f.id, snapshotId, f.path, f.language, f.size, f.loc, crypto.createHash("sha1").update(f.content).digest("hex"), r?.complexity ?? 0, r?.maxFunctionLines ?? 0, f.isTest ? 1 : 0, r?.parsed ? 1 : 0);
    }
    for (const f of files) {
      const r = parse.get(f.path);
      if (f.language && f.language !== "json" || f.path.endsWith("package.json")) insFts.run(f.path, f.content.slice(0, 200_000), f.id, snapshotId);
      for (const s of r?.symbols ?? []) insSym.run(newId("sym_"), snapshotId, f.id, s.name.slice(0, 300), s.kind, s.parent ?? null, s.line, s.end_line, s.signature ?? null, s.exported ? 1 : 0, s.complexity, JSON.stringify(s.meta ?? {}));
      for (const m of schemaModels(f)) insSym.run(newId("sym_"), snapshotId, f.id, m.name, "model", null, m.line, m.line, null, 1, 1, JSON.stringify({ orm: m.orm }));

      const importedFiles = new Set<string>();
      for (const imp of r?.imports ?? []) {
        const res = resolve(f.path, imp.spec, f.language);
        if (res.file) {
          importedFiles.add(res.file);
          insEdge.run(snapshotId, "import", f.id, null, fileIdByPath.get(res.file)!, imp.names.join(",").slice(0, 300) || null, null, imp.line);
        } else {
          insEdge.run(snapshotId, "import", f.id, null, null, imp.names.join(",").slice(0, 300) || null, res.external ?? imp.spec, imp.line);
          if (res.relative && !f.isTest) {
            indexFindings.push({
              source: "bug", tool: "devforge-resolver", rule_id: "imports/unresolved-relative", title: `Broken import: "${imp.spec}"`, category: "Broken imports",
              severity: "high", confidence: f.language === "python" ? "medium" : "high", file_path: f.path, line: imp.line,
              snippet: f.content.split("\n")[imp.line - 1]?.trim().slice(0, 300),
              evidence: `Relative import "${imp.spec}" from ${f.path} does not resolve to any file in the repository.`,
              explanation: "The imported module path does not exist (file moved, renamed, wrong extension or case).",
              impact: "Module loading fails at runtime or build time.",
              recommendation: "Correct the import path or restore the missing module.",
              verification: "Build/type-check succeeds and the module loads.",
            });
          }
        }
      }
      // call edges: resolve callee to a symbol in the same file or an imported file
      const seen = new Set<string>();
      for (const c of r?.calls ?? []) {
        const simple = c.callee.split(".").pop()!.replace(/\(\)$/, "");
        const candidates = symbolFiles.get(simple);
        if (!candidates) continue;
        const target = candidates.includes(f.path) ? f.path : candidates.find((p) => importedFiles.has(p));
        if (!target) continue;
        const key = `${c.caller}>${target}:${simple}`;
        if (seen.has(key)) continue;
        seen.add(key);
        insEdge.run(snapshotId, "call", f.id, c.caller, fileIdByPath.get(target)!, simple, null, c.line);
      }
    }
  })();

  const manifests = files.filter((f) => isManifest(f.path)).map((f) => f.path);
  const frameworks = detectFrameworks(root, manifests, files);
  const langs: Record<string, { files: number; loc: number }> = {};
  for (const f of files) if (f.language) {
    langs[f.language] ??= { files: 0, loc: 0 };
    langs[f.language].files++;
    langs[f.language].loc += f.loc;
  }
  const codeFiles = files.filter((f) => f.language && CODE_LANGS.has(f.language));
  const loc = codeFiles.reduce((a, f) => a + f.loc, 0);
  const symCounts = d.prepare(`SELECT kind, COUNT(*) AS n FROM symbols WHERE snapshot_id = ? GROUP BY kind`).all(snapshotId) as { kind: string; n: number }[];
  const stats = {
    files: files.length,
    codeFiles: codeFiles.length,
    testFiles: codeFiles.filter((f) => f.isTest).length,
    loc,
    testLoc: codeFiles.filter((f) => f.isTest).reduce((a, f) => a + f.loc, 0),
    languages: langs,
    symbols: Object.fromEntries(symCounts.map((r) => [r.kind, r.n])),
    parsedFiles: [...parse.values()].filter((r) => r.parsed).length,
    unsupportedLanguages: Object.keys(langs).filter((l) => CODE_LANGS.has(l) && !["typescript", "javascript", "python"].includes(l)),
  };
  d.prepare(`UPDATE snapshots SET status = 'ready', file_count = ?, loc = ?, stats = ? WHERE id = ?`).run(files.length, loc, JSON.stringify(stats), snapshotId);
  log(`Indexed ${files.length} files, ${loc} LOC, ${Object.values(stats.symbols).reduce((a, b) => a + b, 0)} symbols`);
  if (stats.unsupportedLanguages.length) log(`AST analysis is not available for: ${stats.unsupportedLanguages.join(", ")} (indexed for search, metrics and pattern rules only)`);
  return { snapshotId, root, files, parse, manifests, frameworks, indexFindings };
}

/** Parse every TS/JS/Python file in the context (used when analysing an existing snapshot). */
export async function reparse(ctx: IndexContext, log: Log) {
  for (const f of ctx.files) {
    if ((f.language === "typescript" || f.language === "javascript") && !f.path.endsWith(".json")) {
      try {
        ctx.parse.set(f.path, parseTsFile(f.path, f.content, f.isTest));
      } catch { /* skip */ }
    }
  }
  const py = ctx.files.filter((f) => f.language === "python");
  for (let i = 0; i < py.length; i += 400) {
    const res = await runPython(py.slice(i, i + 400).map((f) => ({ path: f.path, abs: f.abs, isTest: f.isTest })), log);
    for (const [p, r] of Object.entries(res)) {
      const content = py.find((f) => f.path === p)?.content.split("\n") ?? [];
      ctx.parse.set(p, { ...(r as any), findings: ((r as any).findings ?? []).map((x: any) => ({ ...x, file_path: p, snippet: x.snippet ?? content[x.line - 1]?.trim().slice(0, 300) })) });
    }
  }
}

/** Loads an IndexContext for an existing snapshot (re-reads content from disk; reparses for rule findings). */
export function loadContext(snapshotId: string, root: string): IndexContext {
  const rows = db().prepare(`SELECT id, path, language, size, loc, is_test FROM files WHERE snapshot_id = ?`).all(snapshotId) as any[];
  const files: IndexedFile[] = [];
  for (const r of rows) {
    const abs = path.join(root, r.path);
    if (!abs.startsWith(root)) continue;
    let content = "";
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    files.push({ id: r.id, path: r.path, abs, language: r.language, size: r.size, loc: r.loc, content, isTest: !!r.is_test });
  }
  return { snapshotId, root, files, parse: new Map(), manifests: files.filter((f) => isManifest(f.path)).map((f) => f.path), frameworks: [], indexFindings: [] };
}

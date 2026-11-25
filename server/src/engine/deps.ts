import fs from "node:fs";
import path from "node:path";
import type { RawFinding, Severity } from "./types.js";
import { config } from "../config.js";

export interface Dep {
  ecosystem: "npm" | "PyPI" | "Go" | "crates.io" | "RubyGems";
  name: string;
  version_spec: string | null;
  resolved_version: string | null;
  manifest_path: string;
  dev: boolean;
  license?: string | null;
  latest_version?: string | null;
  vulns?: Vuln[];
}
export interface Vuln { id: string; summary: string; severity: Severity; aliases: string[]; fixed?: string | null; url: string }

const MANIFESTS = /(^|\/)(package\.json|package-lock\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|Gemfile\.lock)$/;
export const isManifest = (p: string) => MANIFESTS.test(p) && !p.includes("node_modules/");

/** Parse dependency manifests found in the repository. Lockfiles supply resolved versions when present. */
export function parseManifests(root: string, paths: string[]): Dep[] {
  const deps: Dep[] = [];
  const lockVersions = new Map<string, Map<string, string>>(); // dir -> name -> version
  for (const p of paths.filter((x) => x.endsWith("package-lock.json"))) {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
      const m = new Map<string, string>();
      if (lock.packages) {
        for (const [k, v] of Object.entries<any>(lock.packages)) {
          if (k.startsWith("node_modules/") && !k.slice(13).includes("node_modules/")) m.set(k.slice(13), v.version);
        }
      } else if (lock.dependencies) for (const [k, v] of Object.entries<any>(lock.dependencies)) m.set(k, v.version);
      lockVersions.set(path.dirname(p), m);
    } catch { /* ignore malformed lockfile */ }
  }
  for (const p of paths) {
    const abs = path.join(root, p);
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const base = path.basename(p);
    try {
      if (base === "package.json") {
        const j = JSON.parse(text);
        const lock = lockVersions.get(path.dirname(p));
        for (const [section, dev] of [["dependencies", false], ["devDependencies", true], ["optionalDependencies", false]] as const) {
          for (const [name, spec] of Object.entries<string>(j[section] ?? {})) {
            deps.push({ ecosystem: "npm", name, version_spec: spec, resolved_version: lock?.get(name) ?? exactVersion(spec), manifest_path: p, dev });
          }
        }
      } else if (base.startsWith("requirements") && base.endsWith(".txt")) {
        for (const raw of text.split("\n")) {
          const line = raw.split("#")[0].trim();
          if (!line || line.startsWith("-")) continue;
          const m = line.match(/^([A-Za-z0-9_.\-\[\]]+)\s*(===?|>=|<=|~=|!=|>|<)?\s*([^;\s,]+)?/);
          if (!m) continue;
          const name = m[1].replace(/\[.*\]/, "");
          deps.push({ ecosystem: "PyPI", name, version_spec: m[2] ? m[2] + (m[3] ?? "") : null, resolved_version: m[2] === "==" || m[2] === "===" ? m[3] ?? null : null, manifest_path: p, dev: /dev|test/.test(base) });
        }
      } else if (base === "pyproject.toml") {
        const proj = text.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
        if (proj) {
          for (const m of proj[1].matchAll(/["']([A-Za-z0-9_.\-]+)(\[[^\]]*\])?\s*([<>=!~]=?[^"';]*)?/g)) {
            const spec = m[3]?.trim() || null;
            deps.push({ ecosystem: "PyPI", name: m[1], version_spec: spec, resolved_version: spec?.startsWith("==") ? spec.slice(2).trim() : null, manifest_path: p, dev: false });
          }
        }
        const poetry = text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(\n\[|$)/);
        if (poetry) {
          for (const m of poetry[1].matchAll(/^([A-Za-z0-9_.\-]+)\s*=\s*["']([^"']+)["']/gm)) {
            if (m[1] === "python") continue;
            deps.push({ ecosystem: "PyPI", name: m[1], version_spec: m[2], resolved_version: exactVersion(m[2]), manifest_path: p, dev: false });
          }
        }
      } else if (base === "go.mod") {
        for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]{2,}\/[^\s]+)\s+(v[0-9][^\s]*)/gm)) {
          deps.push({ ecosystem: "Go", name: m[1], version_spec: m[2], resolved_version: m[2].replace(/^v/, "").replace(/\+incompatible$/, ""), manifest_path: p, dev: false });
        }
      } else if (base === "Cargo.toml") {
        const sec = text.match(/\[dependencies\]([\s\S]*?)(\n\[|$)/);
        if (sec) for (const m of sec[1].matchAll(/^([A-Za-z0-9_\-]+)\s*=\s*(?:["']([^"']+)["']|\{[^}]*version\s*=\s*["']([^"']+)["'])/gm)) {
          const spec = m[2] ?? m[3];
          deps.push({ ecosystem: "crates.io", name: m[1], version_spec: spec, resolved_version: exactVersion(spec), manifest_path: p, dev: false });
        }
      } else if (base === "Gemfile.lock") {
        const specs = text.match(/GEM[\s\S]*?specs:\n([\s\S]*?)\n\n/);
        if (specs) for (const m of specs[1].matchAll(/^ {4}([A-Za-z0-9_\-]+) \(([^)]+)\)$/gm)) {
          deps.push({ ecosystem: "RubyGems", name: m[1], version_spec: m[2], resolved_version: m[2], manifest_path: p, dev: false });
        }
      }
    } catch {
      /* skip unparsable manifest */
    }
  }
  return deps;
}

function exactVersion(spec: string | null | undefined): string | null {
  if (!spec) return null;
  const m = spec.trim().match(/^[=v]?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)$/);
  return m ? m[1] : null;
}
/** Lowest version satisfying a caret/tilde/>= range — used only when no lockfile exists (lower confidence). */
export function floorVersion(spec: string | null): string | null {
  if (!spec) return null;
  const m = spec.match(/(\d+\.\d+(?:\.\d+)?)/);
  if (!m) return null;
  return m[1].split(".").length === 2 ? m[1] + ".0" : m[1];
}

function osvSeverity(v: any): Severity {
  const s = (v.database_specific?.severity ?? "").toString().toUpperCase();
  if (s === "CRITICAL") return "critical";
  if (s === "HIGH") return "high";
  if (s === "MODERATE" || s === "MEDIUM") return "medium";
  if (s === "LOW") return "low";
  const cvss = (v.severity ?? []).find((x: any) => typeof x.score === "string");
  if (cvss) {
    const num = Number((cvss.score.match(/\/(\d+(\.\d+)?)$/) ?? [])[1]);
    if (num >= 9) return "critical";
    if (num >= 7) return "high";
    if (num >= 4) return "medium";
  }
  return "medium";
}

/** OSV endpoint (overridable for tests and mirrors). */
const OSV_URL = () => (process.env.DEVFORGE_OSV_URL ?? "https://api.osv.dev").replace(/\/$/, "");

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 15000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal, headers: { "User-Agent": "DevForge-AI-Scanner", ...(init?.headers ?? {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Query OSV.dev for known vulnerabilities. Only package names + versions are sent.
 * Returns a status describing what actually happened (never fakes success).
 */
export async function queryOsv(deps: Dep[], log: (m: string) => void): Promise<{ status: "ok" | "skipped" | "failed"; note: string; checked: number }> {
  if (!config.osvEnabled) return { status: "skipped", note: "OSV lookups disabled (OSV_ENABLED=false)", checked: 0 };
  const queryable = deps.map((d) => ({ d, v: d.resolved_version ?? floorVersion(d.version_spec) })).filter((x) => x.v);
  if (!queryable.length) return { status: "skipped", note: "No dependencies with determinable versions", checked: 0 };
  try {
    for (let i = 0; i < queryable.length; i += 500) {
      const chunk = queryable.slice(i, i + 500);
      const res = await fetchJson(`${OSV_URL()}/v1/querybatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries: chunk.map((x) => ({ package: { name: x.d.name, ecosystem: x.d.ecosystem }, version: x.v })) }),
      }, 30000);
      const ids = new Set<string>();
      res.results.forEach((r: any, j: number) => {
        chunk[j].d.vulns = (r.vulns ?? []).map((v: any) => ({ id: v.id }) as Vuln);
        for (const v of r.vulns ?? []) ids.add(v.id);
      });
      // hydrate vulnerability details (bounded)
      const details = new Map<string, any>();
      const idList = [...ids].slice(0, 200);
      await Promise.all(
        idList.map(async (id, k) => {
          await new Promise((r) => setTimeout(r, (k % 20) * 25));
          try {
            details.set(id, await fetchJson(`${OSV_URL()}/v1/vulns/${encodeURIComponent(id)}`));
          } catch { /* keep id-only */ }
        }),
      );
      for (const x of chunk) {
        x.d.vulns = (x.d.vulns ?? []).map((v) => {
          const det = details.get(v.id);
          const fixed = det?.affected?.flatMap((a: any) => a.ranges ?? []).flatMap((r: any) => r.events ?? []).find((e: any) => e.fixed)?.fixed ?? null;
          return { id: v.id, summary: det?.summary ?? det?.details?.slice(0, 200) ?? v.id, severity: det ? osvSeverity(det) : "medium", aliases: det?.aliases ?? [], fixed, url: `https://osv.dev/vulnerability/${v.id}` };
        });
      }
    }
    log(`OSV: checked ${queryable.length} packages`);
    return { status: "ok", note: `Checked ${queryable.length} packages against OSV.dev`, checked: queryable.length };
  } catch (e: any) {
    log(`OSV lookup failed: ${e.message}`);
    return { status: "failed", note: `OSV.dev unreachable: ${e.message}`, checked: 0 };
  }
}

/** Fetch latest version + license from public registries (npm / PyPI). Bounded concurrency. */
export async function enrichRegistry(deps: Dep[], log: (m: string) => void): Promise<{ status: "ok" | "partial" | "failed" | "skipped"; checked: number }> {
  if (!config.osvEnabled || process.env.DEVFORGE_REGISTRY_LOOKUPS === "false") return { status: "skipped", checked: 0 };
  const targets = deps.filter((d) => d.ecosystem === "npm" || d.ecosystem === "PyPI").slice(0, 300);
  let ok = 0;
  let fail = 0;
  const queue = [...targets];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (queue.length) {
        const d = queue.shift()!;
        try {
          if (d.ecosystem === "npm") {
            const j = await fetchJson(`https://registry.npmjs.org/${d.name.replace("/", "%2F")}/latest`, undefined, 10000);
            d.latest_version = j.version ?? null;
            d.license = typeof j.license === "string" ? j.license : j.license?.type ?? null;
          } else {
            const j = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(d.name)}/json`, undefined, 10000);
            d.latest_version = j.info?.version ?? null;
            d.license = (j.info?.license_expression || j.info?.license || "").slice(0, 60) || (j.info?.classifiers ?? []).find((c: string) => c.startsWith("License ::"))?.split("::").pop()?.trim() || null;
          }
          ok++;
        } catch {
          fail++;
        }
      }
    }),
  );
  log(`Registry metadata: ${ok} ok, ${fail} failed`);
  return { status: fail === 0 ? "ok" : ok > 0 ? "partial" : "failed", checked: ok };
}

const COPYLEFT = /\b(A?GPL|LGPL|SSPL|EUPL|MPL|CC-BY-SA|OSL)/i;
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.+-]/).map((x) => parseInt(x, 10));
  const pb = b.replace(/^v/, "").split(/[.+-]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export function dependencyFindings(deps: Dep[]): RawFinding[] {
  const out: RawFinding[] = [];
  for (const d of deps) {
    const ver = d.resolved_version ?? floorVersion(d.version_spec);
    for (const v of d.vulns ?? []) {
      out.push({
        source: "dependency", tool: "osv.dev", rule_id: `vuln/${v.id}`, title: `${d.name}@${ver}: ${v.summary.slice(0, 120)}`, category: "Vulnerable dependencies",
        severity: v.severity, confidence: d.resolved_version ? "high" : "medium", file_path: d.manifest_path, line: null,
        evidence: `OSV advisory ${v.id}${v.aliases.length ? ` (${v.aliases.slice(0, 3).join(", ")})` : ""} affects ${d.ecosystem} package ${d.name} version ${ver}${d.resolved_version ? "" : " (version inferred from range; no lockfile)"}.`,
        explanation: v.summary,
        impact: "The application ships a dependency version with a publicly known vulnerability.",
        recommendation: v.fixed ? `Upgrade ${d.name} to ${v.fixed} or later.` : `Check ${v.url} for remediation guidance; no fixed version is listed.`,
        verification: "Re-run the dependency scan after upgrading; the advisory should no longer match.",
        related: [v.url],
      });
    }
    if (d.license && COPYLEFT.test(d.license) && !d.dev) {
      out.push({
        source: "dependency", tool: "registry-metadata", rule_id: "license/copyleft", title: `Copyleft license: ${d.name} (${d.license})`, category: "License risks",
        severity: "low", confidence: "medium", file_path: d.manifest_path,
        evidence: `Registry metadata lists license "${d.license}" for ${d.name}.`,
        explanation: "Copyleft licenses can impose source-disclosure obligations depending on how the software is distributed.",
        impact: "Potential legal/compliance obligations.",
        recommendation: "Confirm with your legal/compliance policy, or replace the dependency.",
        verification: "License review recorded.",
      });
    }
    if (d.latest_version && ver && /^\d/.test(d.latest_version) && compareVersions(d.latest_version, ver) > 0) {
      const major = parseInt(d.latest_version, 10) > parseInt(ver, 10);
      if (major) {
        out.push({
          source: "dependency", tool: "registry-metadata", rule_id: "deps/outdated-major", title: `${d.name} is a major version behind (${ver} → ${d.latest_version})`, category: "Outdated packages",
          severity: "info", confidence: d.resolved_version ? "high" : "medium", file_path: d.manifest_path,
          evidence: `Installed/declared ${ver}; latest published ${d.latest_version}.`,
          explanation: "Major versions behind usually miss security fixes and make future upgrades harder.",
          impact: "Upgrade effort accumulates; may miss fixes.",
          recommendation: `Review the ${d.name} changelog and plan an upgrade to ${d.latest_version}.`,
          verification: "Tests pass after upgrade.",
        });
      }
    }
  }
  // Conflicts: same package, different exact versions across manifests
  const byName = new Map<string, Set<string>>();
  for (const d of deps) if (d.resolved_version) {
    const k = `${d.ecosystem}:${d.name}`;
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k)!.add(d.resolved_version);
  }
  for (const [k, vs] of byName) if (vs.size > 1) {
    out.push({
      source: "dependency", tool: "devforge-deps", rule_id: "deps/version-conflict", title: `Conflicting versions of ${k.split(":")[1]}: ${[...vs].join(", ")}`, category: "Conflicts",
      severity: "low", confidence: "high", file_path: null,
      evidence: `Different manifests resolve ${k} to ${[...vs].join(", ")}.`,
      explanation: "Multiple versions of the same package across packages of a monorepo cause duplicated bundles and inconsistent behaviour.",
      impact: "Larger bundles; subtle behavioural differences between packages.",
      recommendation: "Align on a single version across manifests.",
      verification: "All manifests resolve to the same version.",
    });
  }
  return out;
}

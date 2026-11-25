import crypto from "node:crypto";
import type { RawFinding, ParsedSymbol } from "../types.js";

export const THRESHOLDS = { longFunction: 80, complexFunction: 15, largeFile: 800, duplicateWindow: 8 };

export function debtForFile(file: { path: string; loc: number; isTest: boolean }, symbols: ParsedSymbol[]): RawFinding[] {
  if (file.isTest) return [];
  const out: RawFinding[] = [];
  for (const s of symbols) {
    if (s.kind !== "function" && s.kind !== "method" && s.kind !== "component") continue;
    const len = s.end_line - s.line + 1;
    if (len > THRESHOLDS.longFunction) {
      out.push({
        source: "debt", tool: "devforge-metrics", rule_id: "debt/long-function", title: `Long function: ${s.name} (${len} lines)`, category: "Long functions",
        severity: len > 200 ? "medium" : "low", confidence: "high", file_path: file.path, line: s.line, end_line: s.end_line,
        evidence: `${s.name} spans lines ${s.line}-${s.end_line} (${len} lines; threshold ${THRESHOLDS.longFunction}).`,
        explanation: "Long functions usually mix several responsibilities and are hard to test in isolation.",
        impact: "Higher defect rate and slower changes in this area.",
        recommendation: "Extract cohesive blocks into well-named helper functions.",
        verification: "Re-run analysis; function length drops below threshold and tests still pass.",
      });
    }
    if (s.complexity > THRESHOLDS.complexFunction) {
      out.push({
        source: "debt", tool: "devforge-metrics", rule_id: "debt/high-complexity", title: `High cyclomatic complexity: ${s.name} (${s.complexity})`, category: "Complexity",
        severity: s.complexity > 30 ? "medium" : "low", confidence: "high", file_path: file.path, line: s.line, end_line: s.end_line,
        evidence: `Cyclomatic complexity ${s.complexity} (threshold ${THRESHOLDS.complexFunction}).`,
        explanation: "Many independent paths through a function make it hard to reason about and to cover with tests.",
        impact: `At least ${s.complexity} test cases are needed for full branch coverage.`,
        recommendation: "Reduce branching via early returns, lookup tables, or splitting the function.",
        verification: "Complexity metric decreases on the next scan.",
      });
    }
  }
  if (file.loc > THRESHOLDS.largeFile) {
    out.push({
      source: "debt", tool: "devforge-metrics", rule_id: "debt/large-file", title: `Large file (${file.loc} lines of code)`, category: "Large files",
      severity: file.loc > 2000 ? "medium" : "low", confidence: "high", file_path: file.path, line: 1,
      evidence: `${file.loc} non-blank lines (threshold ${THRESHOLDS.largeFile}).`,
      explanation: "Very large modules tend to accumulate unrelated responsibilities.",
      impact: "Merge conflicts, slow reviews, and unclear ownership.",
      recommendation: "Split the module along its responsibilities.",
      verification: "File size drops below threshold.",
    });
  }
  return out;
}

export function todoFindings(file: { path: string; content: string; isTest: boolean }): RawFinding[] {
  const out: RawFinding[] = [];
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/(\/\/|#|\/\*|\*)\s*(TODO|FIXME|HACK|XXX)\b[:\s]?(.*)$/);
    if (!m) continue;
    const kind = m[2];
    out.push({
      source: "debt", tool: "devforge-metrics", rule_id: `debt/${kind.toLowerCase()}`, title: `${kind} comment${m[3] ? ": " + m[3].trim().slice(0, 80) : ""}`, category: "Deferred work",
      severity: kind === "FIXME" || kind === "HACK" ? "low" : "info", confidence: "high", file_path: file.path, line: i + 1, snippet: lines[i].trim().slice(0, 300),
      evidence: `Line ${i + 1}: ${lines[i].trim().slice(0, 160)}`,
      explanation: "An explicitly deferred task or known workaround is recorded in the code.",
      impact: kind === "FIXME" || kind === "HACK" ? "Known defect or fragile workaround remains in place." : "Outstanding work item.",
      recommendation: "Track it in your issue tracker, resolve it, or remove the comment if obsolete.",
      verification: "Comment removed after the work is done.",
    });
  }
  return out;
}

/** Detects duplicated blocks across files using hashes of normalised N-line windows. */
export function duplicateFindings(files: { path: string; content: string; isTest: boolean; language: string | null }[]): RawFinding[] {
  const W = THRESHOLDS.duplicateWindow;
  const seen = new Map<string, { path: string; line: number }>();
  const reported = new Set<string>();
  const out: RawFinding[] = [];
  for (const f of files) {
    if (f.isTest || !f.language || ["json", "yaml", "markdown", "text", "xml", "toml", "css", "scss", "html"].includes(f.language)) continue;
    const raw = f.content.split("\n");
    const norm: { text: string; line: number }[] = [];
    raw.forEach((l, i) => {
      const t = l.trim().replace(/\s+/g, " ");
      if (t.length < 4 || /^(\/\/|#|\*|\/\*|import |from |export \{|\}|\);?|\]|end|else|return;?|\{)$/.test(t) || /^(import|from)\s/.test(t)) return;
      norm.push({ text: t, line: i + 1 });
    });
    let skipUntil = -1;
    for (let i = 0; i + W <= norm.length; i++) {
      if (i < skipUntil) continue;
      const block = norm.slice(i, i + W).map((x) => x.text).join("\n");
      if (block.length < 160) continue;
      const h = crypto.createHash("sha1").update(block).digest("hex");
      const prev = seen.get(h);
      if (prev && prev.path !== f.path) {
        const key = [prev.path, f.path].sort().join("|") + ":" + Math.floor(prev.line / 50);
        if (!reported.has(key)) {
          reported.add(key);
          out.push({
            source: "debt", tool: "devforge-metrics", rule_id: "debt/duplicate-code", title: "Duplicated code block", category: "Duplicate code",
            severity: "low", confidence: "high", file_path: f.path, line: norm[i].line, end_line: norm[i + W - 1].line,
            snippet: raw.slice(norm[i].line - 1, norm[i + W - 1].line).join("\n").slice(0, 700),
            evidence: `${W}+ normalised lines at ${f.path}:${norm[i].line} are identical to ${prev.path}:${prev.line}.`,
            explanation: "Copy-pasted logic must be changed in several places, and fixes are easily applied to only one copy.",
            impact: "Inconsistent behaviour after partial fixes; larger maintenance surface.",
            recommendation: "Extract the shared logic into a single function or module.",
            verification: "Duplicate detector no longer reports this pair.",
            related: [`${prev.path}:${prev.line}`],
          });
        }
        skipUntil = i + W;
      } else if (!prev) seen.set(h, { path: f.path, line: norm[i].line });
    }
  }
  return out;
}

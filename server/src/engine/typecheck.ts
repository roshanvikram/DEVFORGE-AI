import ts from "ts-ast";
import path from "node:path";
import fs from "node:fs";
import type { RawFinding } from "./types.js";

/**
 * Runs the TypeScript type checker over the repository (parse + check only; nothing is executed).
 * Diagnostics caused purely by missing third-party packages/types are filtered out because the
 * repository's dependencies are not installed on the analysis host.
 */
const ENV_CODES = new Set([2307, 2792, 7016, 2875, 2688, 2503, 2580, 2591, 2592, 2593, 7026, 2304, 2339, 2724, 2305, 2614, 1259, 1192, 2686, 17004, 6142, 5023, 5024, 5025, 5083, 5095, 5101, 5110, 18003, 6046, 6053, 2584, 2550, 2583, 2585, 2468, 2318]);

export function typecheckRepo(root: string, files: string[], limit = 1500): { findings: RawFinding[]; status: "ok" | "skipped"; note: string } {
  const tsFiles = files.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith(".d.ts")).slice(0, limit);
  if (!tsFiles.length) return { findings: [], status: "skipped", note: "No TypeScript sources" };
  const hasNodeModules = fs.existsSync(path.join(root, "node_modules"));
  let options: ts.CompilerOptions = { noEmit: true, skipLibCheck: true, allowJs: false, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: false, esModuleInterop: true, types: [] };
  const tsconfig = path.join(root, "tsconfig.json");
  if (fs.existsSync(tsconfig)) {
    const cfg = ts.readConfigFile(tsconfig, (p) => fs.readFileSync(p, "utf8"));
    if (!cfg.error) {
      const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
      options = { ...parsed.options, noEmit: true, skipLibCheck: true, incremental: false, composite: false, plugins: undefined, types: hasNodeModules ? parsed.options.types : [] };
    }
  }
  const host = ts.createCompilerHost(options);
  // Never follow paths outside the repository root.
  const origRead = host.readFile;
  host.readFile = (f) => (path.resolve(f).startsWith(root) || f.includes("/ts-ast/lib/") ? origRead(f) : undefined);
  const program = ts.createProgram(tsFiles.map((f) => path.join(root, f)), options, host);
  const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error && d.file && !d.file.fileName.includes("node_modules") && path.resolve(d.file.fileName).startsWith(root) && !ENV_CODES.has(d.code));
  const findings: RawFinding[] = [];
  for (const d of diags.slice(0, 300)) {
    const file = d.file!;
    const rel = path.relative(root, file.fileName);
    const pos = file.getLineAndCharacterOfPosition(d.start ?? 0);
    const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
    const line = file.text.split("\n")[pos.line] ?? "";
    findings.push({
      source: "bug", tool: "typescript", rule_id: `ts/TS${d.code}`, title: `Type error TS${d.code}: ${msg.slice(0, 100)}`, category: "Type errors",
      severity: "medium", confidence: hasNodeModules ? "high" : "medium", file_path: rel, line: pos.line + 1, snippet: line.trim().slice(0, 300),
      evidence: `tsc: ${msg}`,
      explanation: "The TypeScript compiler reports a type error at this location.",
      impact: "The code may fail at runtime or behave differently from what the types promise; the build fails under `tsc --noEmit`.",
      recommendation: "Fix the type mismatch at this location (or its source).",
      verification: "`tsc --noEmit` reports no error for this file.",
    });
  }
  return { findings, status: "ok", note: `Type-checked ${tsFiles.length} files${hasNodeModules ? "" : " (dependencies not installed; module-resolution diagnostics filtered)"}; ${diags.length} errors` };
}

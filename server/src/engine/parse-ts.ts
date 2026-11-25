import ts from "ts-ast";
import type { ParseResult, ParsedSymbol, RawFinding, ParsedCall, ParsedImport } from "./types.js";

/**
 * TypeScript/JavaScript analyzer built on the TypeScript compiler's parser.
 * Extracts symbols, imports, calls, routes and models, computes cyclomatic complexity,
 * and runs AST-based bug / performance rules in a single traversal.
 */

const DECISION_KINDS = new Set([
  ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.CaseClause, ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);
const LOOP_KINDS = new Set([ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement]);
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "options", "head", "use"]);
const DB_CALL_RE = /^(query|execute|exec|findOne|findMany|findFirst|findUnique|findAll|findById|find|aggregate|count|insert|insertOne|update|updateOne|deleteOne|save|create|upsert|select|raw|get|all|run)$/;
const DB_RECEIVER_RE = /(db|prisma|knex|pool|client|conn|connection|repo|repository|model|collection|sequelize|mongoose|sql|database|em|manager|supabase|redis)/i;

function scriptKind(path: string) {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parseTsFile(path: string, content: string, isTest: boolean): ParseResult {
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind(path));
  const lines = content.split("\n");
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const snippetAt = (start: number, end?: number) => {
    const a = lineOf(start);
    const b = Math.min(end ? lineOf(end) : a, a + 6);
    return lines.slice(a - 1, b).join("\n").slice(0, 800);
  };

  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const calls: ParsedCall[] = [];
  const findings: RawFinding[] = [];
  let fileComplexity = 0;
  let maxFnLines = 0;

  const isExported = (n: ts.Node) =>
    !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) ||
    (ts.isVariableDeclaration(n) && !!(n.parent?.parent && ts.canHaveModifiers(n.parent.parent) && ts.getModifiers(n.parent.parent as ts.VariableStatement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)));

  const add = (f: Omit<RawFinding, "file_path">) => findings.push({ ...f, file_path: path });

  function complexityOf(fn: ts.Node): number {
    let c = 1;
    const visit = (n: ts.Node) => {
      if (n !== fn && (ts.isFunctionLike(n) || ts.isClassLike(n))) return; // nested functions counted separately
      if (DECISION_KINDS.has(n.kind)) c++;
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)) c++;
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn, visit);
    return c;
  }

  const fnStack: string[] = [];
  let loopDepth = 0;
  const declaredNames = new Map<string, { line: number; kind: string; exported: boolean }>();
  const importedNames = new Map<string, number>();
  const identifierUse = new Map<string, number>();

  function fnName(n: ts.Node): string | null {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText(sf);
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) return n.parent.name.text;
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isPropertyAssignment(n.parent)) return n.parent.name.getText(sf);
    return null;
  }

  function recordFunction(n: ts.FunctionLikeDeclaration, name: string, kind: ParsedSymbol["kind"], parent: string | null) {
    const start = lineOf(n.getStart(sf));
    const end = lineOf(n.getEnd());
    const cx = complexityOf(n);
    fileComplexity += cx;
    maxFnLines = Math.max(maxFnLines, end - start + 1);
    const params = n.parameters.map((p) => p.getText(sf)).join(", ").slice(0, 200);
    const isAsync = !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
    const isComponent = /^[A-Z]/.test(name) && (path.endsWith("x") || /return\s*\(?\s*</.test(n.getText(sf).slice(0, 4000)));
    symbols.push({
      name,
      kind: isComponent && kind === "function" ? "component" : kind,
      parent,
      line: start,
      end_line: end,
      signature: `${isAsync ? "async " : ""}${name}(${params})`,
      exported: isExported(n) || (ts.isVariableDeclaration(n.parent) && isExported(n.parent)),
      complexity: cx,
      meta: { async: isAsync, params: n.parameters.length, hasDoc: hasJsDoc(n) },
    });
  }

  function hasJsDoc(n: ts.Node): boolean {
    const target = ts.isVariableDeclaration(n.parent) ? n.parent.parent?.parent ?? n : n;
    return ts.getJSDocCommentsAndTags(target).length > 0 || /\/\*\*/.test(content.slice(Math.max(0, target.getFullStart()), target.getStart(sf)));
  }

  function calleeName(expr: ts.Expression): string {
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) return `${calleeName(expr.expression)}.${expr.name.text}`;
    if (ts.isCallExpression(expr)) return calleeName(expr.expression) + "()";
    if (expr.kind === ts.SyntaxKind.ThisKeyword) return "this";
    return "?";
  }

  function visit(n: ts.Node, cls: string | null) {
    // ---------------- imports ----------------
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const names: string[] = [];
      const ic = n.importClause;
      if (ic && !ic.isTypeOnly) {
        if (ic.name) names.push(ic.name.text);
        if (ic.namedBindings) {
          if (ts.isNamespaceImport(ic.namedBindings)) names.push(ic.namedBindings.name.text);
          else for (const el of ic.namedBindings.elements) if (!el.isTypeOnly) names.push(el.name.text);
        }
      }
      for (const nm of names) importedNames.set(nm, lineOf(n.getStart(sf)));
      imports.push({ spec: n.moduleSpecifier.text, names, line: lineOf(n.getStart(sf)) });
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      imports.push({ spec: n.moduleSpecifier.text, names: [], line: lineOf(n.getStart(sf)) });
    }
    if (ts.isCallExpression(n) && n.arguments.length === 1 && ts.isStringLiteral(n.arguments[0])) {
      const callee = n.expression;
      if ((ts.isIdentifier(callee) && callee.text === "require") || callee.kind === ts.SyntaxKind.ImportKeyword) {
        imports.push({ spec: (n.arguments[0] as ts.StringLiteral).text, names: [], line: lineOf(n.getStart(sf)) });
      }
    }

    // ---------------- declarations ----------------
    if (ts.isClassDeclaration(n) && n.name) {
      const name = n.name.text;
      const decorators = (ts.canHaveDecorators(n) ? ts.getDecorators(n) ?? [] : []).map((d) => d.expression.getText(sf));
      const isEntity = decorators.some((d) => /^Entity|^Table|^Schema/.test(d));
      symbols.push({ name, kind: isEntity ? "model" : "class", parent: null, line: lineOf(n.getStart(sf)), end_line: lineOf(n.getEnd()), exported: isExported(n), complexity: 1, signature: `class ${name}`, meta: { decorators } });
      declaredNames.set(name, { line: lineOf(n.getStart(sf)), kind: "class", exported: isExported(n) });
      ts.forEachChild(n, (c) => visit(c, name));
      return;
    }
    if (ts.isInterfaceDeclaration(n)) symbols.push({ name: n.name.text, kind: "interface", line: lineOf(n.getStart(sf)), end_line: lineOf(n.getEnd()), exported: isExported(n), complexity: 1 });
    if (ts.isTypeAliasDeclaration(n)) symbols.push({ name: n.name.text, kind: "type", line: lineOf(n.getStart(sf)), end_line: lineOf(n.getEnd()), exported: isExported(n), complexity: 1 });

    let pushed = false;
    if (ts.isFunctionDeclaration(n) && n.name && n.body) {
      recordFunction(n, n.name.text, "function", null);
      declaredNames.set(n.name.text, { line: lineOf(n.getStart(sf)), kind: "function", exported: isExported(n) });
      fnStack.push(n.name.text);
      pushed = true;
    } else if (ts.isMethodDeclaration(n) && n.body) {
      const name = n.name.getText(sf);
      recordFunction(n, name, "method", cls);
      fnStack.push(cls ? `${cls}.${name}` : name);
      pushed = true;
    } else if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
      const name = n.parent.name.text;
      recordFunction(n, name, "function", cls);
      const stmt = n.parent.parent?.parent;
      const exp = !!(stmt && ts.isVariableStatement(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
      declaredNames.set(name, { line: lineOf(n.getStart(sf)), kind: "function", exported: exp });
      fnStack.push(name);
      pushed = true;
    }

    // ---------------- identifier usage (for unused detection) ----------------
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isDeclName =
        (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) ||
        ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isClassDeclaration(p)) && p.name === n);
      if (!isDeclName) identifierUse.set(n.text, (identifierUse.get(n.text) ?? 0) + 1);
    }
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const t = n.tagName.getText(sf).split(".")[0];
      identifierUse.set(t, (identifierUse.get(t) ?? 0) + 1);
    }

    // ---------------- calls, routes, models ----------------
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      calls.push({ caller: fnStack[fnStack.length - 1] ?? null, callee: name, line: lineOf(n.getStart(sf)) });

      // Express / Koa / Fastify / Hono routes: app.get('/path', ...)
      if (ts.isPropertyAccessExpression(n.expression) && HTTP_METHODS.has(n.expression.name.text) && n.arguments[0] && (ts.isStringLiteral(n.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(n.arguments[0]))) {
        const recv = n.expression.expression.getText(sf);
        const routePath = (n.arguments[0] as ts.StringLiteral).text;
        if (/^(app|router|server|api|route|r|fastify|hono)\w*$/i.test(recv) && routePath.startsWith("/")) {
          const method = n.expression.name.text.toUpperCase();
          if (method !== "USE" || n.arguments.length > 1) {
            symbols.push({ name: `${method === "USE" ? "MOUNT" : method} ${routePath}`, kind: "route", line: lineOf(n.getStart(sf)), end_line: lineOf(n.getEnd()), exported: false, complexity: 1, meta: { method, path: routePath, framework: "express-like", handlers: n.arguments.length - 1 } });
          }
        }
      }
      // mongoose.model('User', schema)
      if (/^mongoose\.model$|^model$/.test(name) && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
        symbols.push({ name: (n.arguments[0] as ts.StringLiteral).text, kind: "model", line: lineOf(n.getStart(sf)), end_line: lineOf(n.getEnd()), exported: false, complexity: 1, meta: { orm: "mongoose" } });
      }
      // sequelize.define('User', ...)
      if (/\.define$/.test(name) && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && /sequelize|db/i.test(name)) {
        symbols.push({ name: (n.arguments[0] as ts.StringLiteral).text, kind: "model", line: lineOf(n.getStart(sf)), end_line: lineOf(n.getEnd()), exported: false, complexity: 1, meta: { orm: "sequelize" } });
      }

      if (!isTest) {
        // async callback passed to forEach: promises are not awaited
        if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "forEach") {
          const cb = n.arguments[0];
          if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && ts.getModifiers(cb)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
            add({
              source: "bug", tool: "devforge-ast", rule_id: "js/async-foreach", title: "Async callback passed to forEach", category: "Incorrect async handling",
              severity: "high", confidence: "high", line: lineOf(n.getStart(sf)), snippet: snippetAt(n.getStart(sf)),
              evidence: "Array.prototype.forEach is called with an async function. forEach ignores returned promises.",
              explanation: "The surrounding code continues before the async callbacks finish, and rejections inside the callback become unhandled promise rejections.",
              impact: "Operations may run out of order, the caller may observe incomplete state, and errors are silently lost.",
              recommendation: "Use `for (const item of items) { await ... }` for sequential work, or `await Promise.all(items.map(async item => ...))` for concurrent work.",
              verification: "Add a test asserting that the caller observes all side effects after awaiting the enclosing function.",
            });
          }
        }
        // DB / network call inside loop (N+1)
        if (loopDepth > 0 && ts.isPropertyAccessExpression(n.expression) && DB_CALL_RE.test(n.expression.name.text) && DB_RECEIVER_RE.test(n.expression.expression.getText(sf).slice(0, 80))) {
          add({
            source: "performance", tool: "devforge-ast", rule_id: "perf/query-in-loop", title: "Database call inside a loop (possible N+1)", category: "Slow queries",
            severity: "medium", confidence: "medium", line: lineOf(n.getStart(sf)), snippet: snippetAt(n.getStart(sf)),
            evidence: `\`${n.expression.getText(sf).slice(0, 80)}(...)\` is called inside a loop body.`,
            explanation: "Issuing one query per iteration multiplies round-trips with input size (the N+1 query pattern).",
            impact: "Latency and database load grow linearly with the number of items; can dominate request time.",
            recommendation: "Batch the lookups (e.g. `WHERE id IN (...)`, `findMany({ where: { id: { in: ids } } })`) or prefetch outside the loop.",
            verification: "Measure query count for a request with N items before and after the change.",
          });
        }
        // JSON.parse(JSON.stringify(x)) deep clone
        if (name === "JSON.parse" && n.arguments[0] && ts.isCallExpression(n.arguments[0]) && calleeName(n.arguments[0].expression) === "JSON.stringify") {
          add({
            source: "performance", tool: "devforge-ast", rule_id: "perf/json-deep-clone", title: "Deep clone via JSON round-trip", category: "Excessive computation",
            severity: "low", confidence: "high", line: lineOf(n.getStart(sf)), snippet: snippetAt(n.getStart(sf)),
            evidence: "`JSON.parse(JSON.stringify(...))` is used to copy an object.",
            explanation: "Serialising and re-parsing is slow for large objects and silently drops Dates, Maps, Sets, undefined and functions.",
            impact: "CPU overhead and subtle data corruption for non-JSON values.",
            recommendation: "Use `structuredClone(value)` or a targeted shallow copy.",
            verification: "Unit test that cloned objects with Date/Map values remain intact.",
          });
        }
        // Sync FS calls in server code
        if (/^fs\.(readFileSync|writeFileSync|existsSync|readdirSync|statSync)$/.test(name) && fnStack.length > 0 && /route|controller|handler|api|server/i.test(path)) {
          add({
            source: "performance", tool: "devforge-ast", rule_id: "perf/sync-fs-in-handler", title: "Synchronous filesystem call in request path", category: "Potential bottleneck",
            severity: "medium", confidence: "low", line: lineOf(n.getStart(sf)), snippet: snippetAt(n.getStart(sf)),
            evidence: `\`${name}\` is called inside a function in a server/route module.`,
            explanation: "Synchronous I/O blocks the Node.js event loop, stalling every concurrent request while it runs.",
            impact: "Throughput collapses under load; tail latency increases.",
            recommendation: "Use the promise-based `fs/promises` API or cache the result at startup.",
            verification: "Load-test the endpoint and compare p95 latency.",
          });
        }
      }
    }

    // new Promise(async ...) anti-pattern
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Promise" && n.arguments?.[0] && (ts.isArrowFunction(n.arguments[0]) || ts.isFunctionExpression(n.arguments[0])) && ts.getModifiers(n.arguments[0])?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      add({
        source: "bug", tool: "devforge-ast", rule_id: "js/async-promise-executor", title: "Async function used as Promise executor", category: "Incorrect async handling",
        severity: "medium", confidence: "high", line: lineOf(n.getStart(sf)), snippet: snippetAt(n.getStart(sf)),
        evidence: "`new Promise(async (...) => ...)` — the executor is async.",
        explanation: "If the async executor throws, the error is not propagated to the constructed promise; it becomes an unhandled rejection and the outer promise may never settle.",
        impact: "Hung requests and lost errors.",
        recommendation: "Remove the `new Promise` wrapper and write a plain async function, or keep the executor synchronous.",
        verification: "Test that a failure inside the executor rejects the returned promise.",
      });
    }

    // Await inside loop
    if (ts.isAwaitExpression(n) && loopDepth > 0 && !isTest) {
      add({
        source: "performance", tool: "devforge-ast", rule_id: "perf/await-in-loop", title: "Sequential await inside loop", category: "Inefficient loops",
        severity: "low", confidence: "medium", line: lineOf(n.getStart(sf)), snippet: snippetAt(n.getStart(sf)),
        evidence: "An `await` expression appears inside a loop body, so iterations run strictly one after another.",
        explanation: "When iterations are independent, sequential awaiting turns N parallelisable operations into N round-trips.",
        impact: "Total latency equals the sum of all operations rather than the slowest one.",
        recommendation: "If iterations are independent, collect promises and `await Promise.all(...)` (with a concurrency limit for large inputs). Keep sequential if order matters.",
        verification: "Time the function with a representative input size before and after.",
      });
    }

    // Empty catch
    if (ts.isCatchClause(n) && n.block.statements.length === 0 && !isTest) {
      const hasComment = /\/[/*]/.test(n.block.getText(sf));
      if (!hasComment)
        add({
          source: "bug", tool: "devforge-ast", rule_id: "js/empty-catch", title: "Exception silently swallowed", category: "Unhandled exceptions",
          severity: "medium", confidence: "high", line: lineOf(n.getStart(sf)), snippet: snippetAt(n.getStart(sf), n.getEnd()),
          evidence: "A `catch` block is empty and has no explanatory comment.",
          explanation: "Errors raised in the try block are discarded without logging or handling, hiding failures.",
          impact: "Failures become invisible; the program continues with possibly inconsistent state.",
          recommendation: "Log the error with context, rethrow, or handle it explicitly. If ignoring is intentional, add a comment explaining why.",
          verification: "Force the try block to throw in a test and assert the error is surfaced or handled.",
        });
    }

    // Assignment inside condition
    if ((ts.isIfStatement(n) || ts.isWhileStatement(n)) && ts.isBinaryExpression(n.expression) && n.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      add({
        source: "bug", tool: "devforge-ast", rule_id: "js/assign-in-condition", title: "Assignment used as condition", category: "Suspicious logic",
        severity: "high", confidence: "medium", line: lineOf(n.getStart(sf)), snippet: snippetAt(n.getStart(sf)),
        evidence: `Condition is an assignment: \`${n.expression.getText(sf).slice(0, 80)}\`.`,
        explanation: "`=` assigns rather than compares; the branch depends on the truthiness of the assigned value. This is usually a typo for `===`.",
        impact: "Branch is taken incorrectly and the variable is overwritten.",
        recommendation: "Use `===` for comparison, or wrap in extra parentheses and a comment if the assignment is intentional.",
        verification: "Add a test covering both branches of the condition.",
      });
    }

    // Self comparison x === x
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind) && n.left.getText(sf) === n.right.getText(sf) && !ts.isLiteralExpression(n.left)) {
      add({
        source: "bug", tool: "devforge-ast", rule_id: "js/self-compare", title: "Value compared with itself", category: "Suspicious logic",
        severity: "medium", confidence: "high", line: lineOf(n.getStart(sf)), snippet: snippetAt(n.getStart(sf)),
        evidence: `\`${n.getText(sf).slice(0, 80)}\` compares an expression with itself.`,
        explanation: "The result is constant (except for NaN checks), which almost always indicates a copy-paste mistake.",
        impact: "The intended comparison never happens.",
        recommendation: "Compare against the intended second operand; use `Number.isNaN(x)` for NaN checks.",
        verification: "Unit test with differing operands.",
      });
    }

    // Duplicate keys in object literal
    if (ts.isObjectLiteralExpression(n)) {
      const seen = new Map<string, number>();
      for (const p of n.properties) {
        if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
          const k = p.name.text;
          if (seen.has(k)) {
            add({
              source: "bug", tool: "devforge-ast", rule_id: "js/duplicate-key", title: `Duplicate object key "${k}"`, category: "Suspicious logic",
              severity: "medium", confidence: "high", line: lineOf(p.getStart(sf)), snippet: snippetAt(p.getStart(sf)),
              evidence: `Key "${k}" is defined at line ${seen.get(k)} and again at line ${lineOf(p.getStart(sf))}.`,
              explanation: "The later definition silently overwrites the earlier one.",
              impact: "The first value is lost; behaviour depends on property order.",
              recommendation: "Remove or rename one of the duplicate keys.",
              verification: "Inspect the object at runtime or add a test asserting both values.",
            });
          } else seen.set(k, lineOf(p.getStart(sf)));
        }
      }
    }

    // Unreachable code after return/throw/break/continue
    if (ts.isBlock(n)) {
      const st = n.statements;
      for (let i = 0; i < st.length - 1; i++) {
        const s = st[i];
        if (ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
          const next = st[i + 1];
          if (ts.isFunctionDeclaration(next) || ts.isEmptyStatement(next)) continue; // hoisted
          if (ts.isVariableStatement(next) && next.declarationList.flags & ts.NodeFlags.BlockScoped) {
            // still unreachable, keep
          }
          add({
            source: "bug", tool: "devforge-ast", rule_id: "js/unreachable-code", title: "Unreachable code", category: "Dead code",
            severity: "low", confidence: "high", line: lineOf(next.getStart(sf)), snippet: snippetAt(s.getStart(sf), next.getEnd()),
            evidence: `Statement at line ${lineOf(next.getStart(sf))} follows a \`${s.getText(sf).split(/[\s;(]/)[0]}\` in the same block.`,
            explanation: "Control flow can never reach this statement.",
            impact: "Dead code misleads readers and can hide logic that was meant to run.",
            recommendation: "Remove the unreachable statements or fix the control flow so they execute.",
            verification: "Coverage report should show these lines as never executed.",
          });
          break;
        }
      }
    }

    // debugger statement
    if (n.kind === ts.SyntaxKind.DebuggerStatement && !isTest) {
      add({
        source: "bug", tool: "devforge-ast", rule_id: "js/debugger", title: "debugger statement left in code", category: "Maintainability",
        severity: "low", confidence: "high", line: lineOf(n.getStart(sf)), snippet: snippetAt(n.getStart(sf)),
        evidence: "A `debugger` statement is present.", explanation: "Pauses execution when devtools are open; leftover from debugging.",
        impact: "Unexpected pauses in development; noise in production bundles.", recommendation: "Remove the statement.", verification: "Lint rule `no-debugger`.",
      });
    }

    const isLoop = LOOP_KINDS.has(n.kind) || (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ["forEach", "map", "filter", "reduce"].includes(n.expression.name.text) && !!n.arguments[0] && (ts.isArrowFunction(n.arguments[0]) || ts.isFunctionExpression(n.arguments[0])));
    // nested loop over the same collection
    if (isLoop && loopDepth > 0 && ts.isForOfStatement(n) && !isTest) {
      let p: ts.Node | undefined = n.parent;
      while (p && !ts.isForOfStatement(p)) p = p.parent;
      if (p && ts.isForOfStatement(p) && p.expression.getText(sf) === n.expression.getText(sf)) {
        add({
          source: "performance", tool: "devforge-ast", rule_id: "perf/nested-loop-same-collection", title: "Quadratic nested iteration over the same collection", category: "Inefficient loops",
          severity: "medium", confidence: "medium", line: lineOf(n.getStart(sf)), snippet: snippetAt(p.getStart(sf)),
          evidence: `Both loops iterate \`${n.expression.getText(sf).slice(0, 60)}\`.`,
          explanation: "Nested iteration over the same collection is O(n²).",
          impact: "Runtime grows quadratically with collection size.",
          recommendation: "Index the collection in a Map/Set keyed by the lookup field, then do a single pass.",
          verification: "Benchmark with 10x input size; runtime should grow ~10x, not ~100x.",
        });
      }
    }
    if (isLoop) loopDepth++;
    ts.forEachChild(n, (c) => visit(c, cls));
    if (isLoop) loopDepth--;
    if (pushed) fnStack.pop();
  }

  try {
    visit(sf, null);
  } catch (e) {
    return { symbols, imports, calls, findings, complexity: fileComplexity, maxFunctionLines: maxFnLines, parsed: false };
  }

  // Next.js / Remix file-based API routes
  const nextRoute = path.match(/(?:^|\/)(?:src\/)?(?:app\/(.*)\/route|pages\/api\/(.*))\.(t|j)sx?$/);
  if (nextRoute) {
    const routePath = "/" + (nextRoute[1] ? nextRoute[1] : "api/" + nextRoute[2]).replace(/\/index$/, "");
    const methods = symbols.filter((s) => s.exported && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(s.name)).map((s) => s.name);
    for (const m of methods.length ? methods : ["ANY"]) symbols.push({ name: `${m} ${routePath}`, kind: "route", line: 1, end_line: 1, exported: true, complexity: 1, meta: { method: m, path: routePath, framework: "next" } });
  }

  // Unused imports
  if (!isTest && !path.endsWith(".d.ts")) {
    for (const [nm, line] of importedNames) {
      if (!identifierUse.get(nm) && nm !== "React" && nm !== "h") {
        findings.push({
          source: "bug", tool: "devforge-ast", rule_id: "js/unused-import", title: `Unused import "${nm}"`, category: "Dead code", file_path: path,
          severity: "info", confidence: "medium", line, snippet: lines[line - 1]?.slice(0, 300),
          evidence: `"${nm}" is imported but never referenced in this file.`,
          explanation: "Unused imports add load-time cost and noise, and can keep otherwise-dead modules alive.",
          impact: "Minor: slightly larger bundles and harder-to-read code.",
          recommendation: `Remove "${nm}" from the import statement.`,
          verification: "Type-check / build still passes after removal.",
        });
      }
    }
    // Unused non-exported functions
    for (const [nm, d] of declaredNames) {
      if (d.kind === "function" && !d.exported && !identifierUse.get(nm)) {
        findings.push({
          source: "bug", tool: "devforge-ast", rule_id: "js/unused-function", title: `Function "${nm}" is never used`, category: "Dead code", file_path: path,
          severity: "low", confidence: "medium", line: d.line, snippet: lines[d.line - 1]?.slice(0, 300),
          evidence: `"${nm}" is declared, not exported, and never referenced in the file.`,
          explanation: "Module-private code with no callers is dead.",
          impact: "Maintenance burden; may indicate a missing call.",
          recommendation: "Delete the function, or wire it up where it was intended to be called.",
          verification: "Remove it and confirm the build and tests pass.",
        });
      }
    }
  }

  return { symbols, imports, calls, findings, complexity: fileComplexity, maxFunctionLines: maxFnLines, parsed: true };
}

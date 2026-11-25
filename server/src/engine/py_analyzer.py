"""DevForge AI Python analyzer.

Reads a JSON list of {"path", "abs"} objects on stdin, parses each file with the
standard-library `ast` module (no repository code is imported or executed), and
writes one JSON result per file to stdout.
"""
import ast
import json
import sys

DECISIONS = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler, ast.IfExp, ast.comprehension, ast.Assert, ast.With, ast.AsyncWith)
if hasattr(ast, "Match"):
    DECISIONS = DECISIONS + (ast.match_case,)
LOOPS = (ast.For, ast.AsyncFor, ast.While)
ROUTE_DECOS = {"get", "post", "put", "patch", "delete", "route", "api_route", "websocket", "head", "options"}
DB_METHODS = {"execute", "executemany", "query", "get", "filter", "all", "first", "one", "scalar", "fetchone", "fetchall", "find", "find_one", "insert_one", "update_one", "delete_one", "save", "create", "aggregate", "count"}
DB_RECV = ("db", "session", "cursor", "conn", "connection", "objects", "collection", "engine", "client", "repo", "orm", "query")


def complexity(fn):
    c = 1
    for n in ast.walk(fn):
        if n is fn:
            continue
        if isinstance(n, DECISIONS):
            c += 1
        elif isinstance(n, ast.BoolOp):
            c += len(n.values) - 1
    return c


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return dotted(node.value) + "." + node.attr
    if isinstance(node, ast.Call):
        return dotted(node.func) + "()"
    return "?"


def finding(rule, title, cat, sev, conf, line, evidence, explanation, impact, rec, verif, source="bug"):
    return {
        "source": source, "tool": "devforge-pyast", "rule_id": rule, "title": title, "category": cat,
        "severity": sev, "confidence": conf, "line": line, "evidence": evidence, "explanation": explanation,
        "impact": impact, "recommendation": rec, "verification": verif,
    }


def analyze(path, src, is_test):
    tree = ast.parse(src, filename=path)
    symbols, imports, calls, findings = [], [], [], []
    total_cx = 0
    max_len = 0
    imported = {}
    used = {}

    for n in ast.walk(tree):
        if isinstance(n, ast.Name):
            used[n.id] = used.get(n.id, 0) + 1
        elif isinstance(n, ast.Attribute):
            root = n
            while isinstance(root, ast.Attribute):
                root = root.value
            if isinstance(root, ast.Name):
                used[root.id] = used.get(root.id, 0) + 1
    # names in __all__ count as used
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant) and isinstance(n.value, str):
            used[n.value] = used.get(n.value, 0) + 1

    def visit(node, parent_cls=None, fn_stack=(), loop_depth=0):
        nonlocal total_cx, max_len
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.Import):
                for a in child.names:
                    imports.append({"spec": a.name, "names": [a.asname or a.name.split(".")[0]], "line": child.lineno})
                    imported[a.asname or a.name.split(".")[0]] = child.lineno
            elif isinstance(child, ast.ImportFrom):
                spec = "." * (child.level or 0) + (child.module or "")
                names = [a.asname or a.name for a in child.names if a.name != "*"]
                imports.append({"spec": spec, "names": names, "line": child.lineno})
                if not path.endswith("__init__.py"):
                    for nm in names:
                        imported[nm] = child.lineno

            if isinstance(child, ast.ClassDef):
                bases = [dotted(b) for b in child.bases]
                is_model = any(b.endswith(("Model", "Base", "DeclarativeBase", "SQLModel", "Document", "BaseModel")) for b in bases)
                kind = "model" if is_model and not any(b == "BaseModel" for b in bases) else "class"
                if any(b in ("BaseModel",) for b in bases):
                    kind = "class"
                symbols.append({"name": child.name, "kind": kind, "parent": parent_cls, "line": child.lineno, "end_line": getattr(child, "end_lineno", child.lineno), "exported": not child.name.startswith("_"), "complexity": 1, "signature": f"class {child.name}({', '.join(bases)})", "meta": {"bases": bases, "hasDoc": ast.get_docstring(child) is not None}})
                visit(child, child.name, fn_stack, loop_depth)
                continue

            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                cx = complexity(child)
                total_cx += cx
                end = getattr(child, "end_lineno", child.lineno)
                max_len = max(max_len, end - child.lineno + 1)
                args = [a.arg for a in child.args.args]
                is_async = isinstance(child, ast.AsyncFunctionDef)
                symbols.append({"name": child.name, "kind": "method" if parent_cls else "function", "parent": parent_cls, "line": child.lineno, "end_line": end, "exported": not child.name.startswith("_"), "complexity": cx, "signature": f"{'async ' if is_async else ''}def {child.name}({', '.join(args)})", "meta": {"async": is_async, "params": len(args), "hasDoc": ast.get_docstring(child) is not None}})
                for d in child.decorator_list:
                    target = d.func if isinstance(d, ast.Call) else d
                    name = dotted(target)
                    attr = name.split(".")[-1]
                    if attr in ROUTE_DECOS and isinstance(d, ast.Call) and d.args and isinstance(d.args[0], ast.Constant) and isinstance(d.args[0].value, str):
                        method = attr.upper() if attr not in ("route", "api_route") else "ANY"
                        for kw in d.keywords:
                            if kw.arg == "methods" and isinstance(kw.value, (ast.List, ast.Tuple)):
                                method = ",".join(str(e.value) for e in kw.value.elts if isinstance(e, ast.Constant))
                        symbols.append({"name": f"{method} {d.args[0].value}", "kind": "route", "line": child.lineno, "end_line": end, "exported": True, "complexity": 1, "meta": {"method": method, "path": d.args[0].value, "handler": child.name, "framework": "fastapi/flask"}})
                # mutable default args
                for dflt in child.args.defaults + [d for d in child.args.kw_defaults if d is not None]:
                    if isinstance(dflt, (ast.List, ast.Dict, ast.Set)) and not is_test:
                        findings.append(finding("py/mutable-default-arg", f"Mutable default argument in {child.name}()", "Suspicious logic", "medium", "high", child.lineno,
                            f"Parameter default is a mutable {type(dflt).__name__.lower()} literal.",
                            "Default values are evaluated once at definition time; the same object is shared across all calls.",
                            "State leaks between calls, causing hard-to-reproduce bugs.",
                            "Use `None` as the default and create the object inside the function body.",
                            "Call the function twice and assert the default is not shared."))
                visit(child, parent_cls, fn_stack + (f"{parent_cls}.{child.name}" if parent_cls else child.name,), 0)
                continue

            if isinstance(child, ast.Call):
                name = dotted(child.func)
                calls.append({"caller": fn_stack[-1] if fn_stack else None, "callee": name, "line": child.lineno})
                attr = name.split(".")[-1]
                if loop_depth > 0 and attr in DB_METHODS and any(r in name.lower() for r in DB_RECV) and not is_test:
                    findings.append(finding("perf/query-in-loop", "Database call inside a loop (possible N+1)", "Slow queries", "medium", "medium", child.lineno,
                        f"`{name}(...)` is called inside a loop body.",
                        "Issuing one query per iteration multiplies round-trips with input size.",
                        "Latency and database load grow linearly with the number of items.",
                        "Batch the query (e.g. `filter(id__in=ids)`, `WHERE id IN (...)`) or prefetch/select_related outside the loop.",
                        "Count queries for a request with N items before and after.", source="performance"))
                if name == "open" and not isinstance(node, (ast.With, ast.AsyncWith, ast.withitem)) and not is_test:
                    findings.append(finding("py/open-without-with", "File opened without a context manager", "Resource leaks", "low", "medium", child.lineno,
                        "`open(...)` result is not managed by a `with` block.",
                        "If an exception occurs before `close()`, the file handle leaks.",
                        "File descriptor exhaustion in long-running processes.",
                        "Use `with open(...) as f:`.",
                        "Run under `python -X dev` / ResourceWarning to confirm no leaks."))

            if isinstance(child, ast.ExceptHandler):
                if child.type is None and not is_test:
                    findings.append(finding("py/bare-except", "Bare `except:` clause", "Unhandled exceptions", "medium", "high", child.lineno,
                        "`except:` without an exception type catches everything, including KeyboardInterrupt and SystemExit.",
                        "Bare except hides programming errors and interferes with shutdown.",
                        "Real failures are masked; the process may ignore Ctrl-C.",
                        "Catch specific exceptions, or at minimum `except Exception:` and log the error.",
                        "Raise a specific exception in a test and assert it is handled/logged correctly."))
                if len(child.body) == 1 and isinstance(child.body[0], ast.Pass) and not is_test:
                    findings.append(finding("py/except-pass", "Exception silently swallowed", "Unhandled exceptions", "medium", "high", child.lineno,
                        "Exception handler body is only `pass`.",
                        "Errors are discarded without logging or handling.",
                        "Failures become invisible; execution continues with inconsistent state.",
                        "Log the exception or handle it explicitly; document intentional suppression with `contextlib.suppress`.",
                        "Force the guarded code to fail in a test and assert the error surfaces."))

            if isinstance(child, ast.Compare) and not is_test:
                for op, comp in zip(child.ops, child.comparators):
                    if isinstance(op, (ast.Eq, ast.NotEq)) and isinstance(comp, ast.Constant) and comp.value is None:
                        findings.append(finding("py/compare-none-eq", "Comparison to None with ==", "Suspicious logic", "low", "high", child.lineno,
                            "`== None` / `!= None` used instead of identity check.",
                            "Objects can override `__eq__`, so equality with None may give unexpected results.",
                            "Subtle logic errors with custom types (e.g. numpy arrays, ORM columns outside queries).",
                            "Use `is None` / `is not None`.", "Ruff rule E711."))

            if isinstance(child, (ast.Return, ast.Raise, ast.Continue, ast.Break)):
                body = getattr(node, "body", None)
                if isinstance(body, list) and child in body:
                    idx = body.index(child)
                    if idx < len(body) - 1:
                        nxt = body[idx + 1]
                        findings.append(finding("py/unreachable-code", "Unreachable code", "Dead code", "low", "high", nxt.lineno,
                            f"Statement at line {nxt.lineno} follows a `{type(child).__name__.lower()}` in the same block.",
                            "Control flow can never reach this statement.",
                            "Dead code misleads readers and can hide logic that was meant to run.",
                            "Remove it or fix the control flow.", "Coverage shows these lines as never executed."))

            new_depth = loop_depth + 1 if isinstance(child, LOOPS) else loop_depth
            visit(child, parent_cls, fn_stack, new_depth)

    visit(tree)

    if not is_test and not path.endswith("__init__.py"):
        for nm, line in imported.items():
            if not used.get(nm):
                findings.append(finding("py/unused-import", f'Unused import "{nm}"', "Dead code", "info", "medium", line,
                    f'"{nm}" is imported but never referenced in this module.',
                    "Unused imports slow module load and add noise; can mask circular-import issues.",
                    "Minor maintainability cost.", f'Remove the import of "{nm}".', "Ruff rule F401."))

    return {"symbols": symbols, "imports": imports, "calls": calls, "findings": findings, "complexity": total_cx, "maxFunctionLines": max_len, "parsed": True}


def main():
    items = json.load(sys.stdin)
    out = {}
    for it in items:
        try:
            with open(it["abs"], "r", encoding="utf-8", errors="replace") as fh:
                src = fh.read()
            out[it["path"]] = analyze(it["path"], src, it.get("isTest", False))
        except SyntaxError as e:
            out[it["path"]] = {"symbols": [], "imports": [], "calls": [], "complexity": 0, "maxFunctionLines": 0, "parsed": False,
                "findings": [finding("py/syntax-error", "Python syntax error", "Type errors", "high", "high", e.lineno or 1,
                    f"Parser error: {e.msg}", "The file cannot be parsed by the Python interpreter.",
                    "Importing this module raises SyntaxError at runtime.", "Fix the syntax error.", "`python -m py_compile <file>` succeeds.")]}
        except Exception as e:  # noqa: BLE001 - report analyzer failure per file
            out[it["path"]] = {"symbols": [], "imports": [], "calls": [], "findings": [], "complexity": 0, "maxFunctionLines": 0, "parsed": False, "error": str(e)[:200]}
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()

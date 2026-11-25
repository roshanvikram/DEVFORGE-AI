# Agent system

## Agents

Defined in `server/src/agents/definitions.ts`. Each has a role, instructions, an allow-list of tools, limits (steps, tool calls, time), and a deterministic playbook used when no AI provider is configured.

| Agent | Focus | Tools beyond the shared read tools |
| --- | --- | --- |
| Repository Analyst | Explain an unfamiliar codebase | architecture_summary |
| Bug Investigator | Find defects | run_scan, record_hypothesis, handoff |
| Root Cause Engineer | Explain failures | record_hypothesis, handoff |
| Security Auditor | Security posture | run_scan, dependency_report, record_hypothesis |
| Code Reviewer | Code quality | record_hypothesis |
| Test Engineer | Coverage | architecture_summary, generate_tests |
| Performance Engineer | Bottlenecks | run_scan, record_hypothesis |
| Architecture Analyst | Design | architecture_summary, run_scan |
| Dependency Analyst | Third-party risk | dependency_report, run_scan (restricted read set: repository_overview, search_code, list_findings) |
| Documentation Agent | Docs | architecture_summary, save_document |

Shared read tools (all agents except the Dependency Analyst, which has a narrower set): `repository_overview`, `search_code`, `find_symbol`, `read_file`, `list_files`, `get_callers`, `get_dependencies`, `list_findings`. Agents with `handoff` can delegate a follow-up task to another agent; the child run is linked to its parent.

## Execution (`agents/runner.ts`)

- **With Claude:** a manual tool loop. Each turn sends the agent's instructions, the conversation and only its allowed tool definitions. `tool_use` blocks are executed server-side against the indexed repository and returned as `tool_result`s (truncated); the loop ends on a text-only answer, the step limit or the time limit. Tokens and cost are added to the run.
- **Without Claude:** the playbook runs real tools in order and a report is assembled from their actual output — clearly labelled as deterministic.
- Every plan, tool call, result and message is stored in `agent_steps` and streamed live (`agent_step` events).

## Guardrails

- Tools are read-only against the repository except `run_scan` (queues a normal scan), `record_hypothesis` (stored with `origin = ai_hypothesis`), `save_document` (knowledge base) and `generate_tests` (writes only inside a sandbox workdir).
- No tool writes to the repository or applies patches. Proposed fixes are shown for review only.
- File reads are confined to the repository checkout (`safePath`); paths are normalised and traversal is rejected.
- Per-workspace AI rate limit (`AI_RATE_PER_MIN`) and monthly budget; requests stop with a clear error when exceeded.
- Code context is retrieval-bounded (character budget), never the whole repository; workspaces can disable sending code to AI.

## AI features outside agents

| Feature | Call | Output handling |
| --- | --- | --- |
| Investigations | Structured output (JSON schema) with retrieved code + evidence | Hypotheses marked `ai_hypothesis`; cited files checked against the repository; patch never applied |
| Code review | Structured output over the diff | Findings stored with `origin = ai_hypothesis`, separate from detected ones |
| Test generation | Structured output → test files | Files executed only in the sandbox; results parsed from the runner |
| Repository Q&A | Streaming text with code excerpts | Citations returned alongside the answer |

## Workflows (`workflows/engine.ts`)

Node types: `trigger`, `repo_analyzer`, `agent`, `security_scan`, `bug_scan`, `test_generator`, `test_runner`, `code_review`, `condition`, `approval`, `notification`, `report`, `end`.

- Definitions are validated as DAGs (unknown types, missing edges and cycles are rejected).
- Conditions use a small safe expression evaluator over previous node outputs (no `eval`).
- `approval` nodes pause the execution until a user with `approvals.decide` approves or rejects it.
- Nodes support retries and `onError` (stop / continue).
- Notification nodes post to Slack or https webhooks, with the same SSRF checks as git import.
- Long work runs inline inside the workflow job (`runInline`) to avoid worker-slot deadlocks.

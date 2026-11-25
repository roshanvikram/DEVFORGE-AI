/**
 * Specialised agents. Each agent has: responsibilities, system instructions, an explicit tool allowlist
 * (permissions), execution limits, an output contract, and a deterministic playbook used when no AI
 * provider is configured (so agents always execute real tool work instead of animating fake progress).
 */
export interface AgentDef {
  key: string;
  name: string;
  role: string;
  responsibilities: string[];
  instructions: string;
  tools: string[];
  limits: { maxSteps: number; maxToolCalls: number; timeoutSec: number };
  outputs: string[];
  /** Deterministic tool sequence used without AI; each step's input may depend on the task. */
  playbook: { tool: string; input: (task: string) => Record<string, unknown> }[];
  defaultTask: string;
}

const READ_TOOLS = ["repository_overview", "search_code", "find_symbol", "read_file", "list_files", "get_callers", "get_dependencies", "list_findings"];

const BASE = `You are a DevForge AI specialist agent operating on ONE repository through tools. Rules:
- Ground every claim in tool output; cite files as path:line.
- Never claim a scan ran or a bug exists unless a tool result shows it. Label inferences as hypotheses.
- Be efficient: plan briefly, call the tools you need, then stop.
- Never output secrets. You cannot modify repository files.
- Finish with a concise Markdown report: ## Summary, ## Findings (with evidence), ## Recommendations, ## Limitations.`;

export const AGENTS: AgentDef[] = [
  {
    key: "repository_analyst", name: "Repository Analyst", role: "Understands unfamiliar codebases",
    responsibilities: ["Map languages, frameworks, entry points", "Explain module structure", "Identify API routes and data models"],
    instructions: `${BASE}\nYou explain how the repository is organised: entry points, key modules, APIs, data models and how they connect.`,
    tools: [...READ_TOOLS, "architecture_summary"], limits: { maxSteps: 12, maxToolCalls: 20, timeoutSec: 600 },
    outputs: ["Repository overview report"],
    playbook: [{ tool: "repository_overview", input: () => ({}) }, { tool: "architecture_summary", input: () => ({}) }],
    defaultTask: "Produce an onboarding overview of this repository.",
  },
  {
    key: "bug_investigator", name: "Bug Investigator", role: "Finds defects",
    responsibilities: ["Run bug and type analysis", "Triage detected bugs by impact", "Spot likely defects near hotspots"],
    instructions: `${BASE}\nYou hunt for real defects. Start from detected findings, read the code to confirm, and record new hypotheses only with concrete evidence.`,
    tools: [...READ_TOOLS, "run_scan", "record_hypothesis", "handoff"], limits: { maxSteps: 16, maxToolCalls: 30, timeoutSec: 900 },
    outputs: ["Bug triage report", "AI hypotheses (labelled)"],
    playbook: [{ tool: "run_scan", input: () => ({ kinds: ["bug"] }) }, { tool: "list_findings", input: () => ({ source: "bug", limit: 25 }) }],
    defaultTask: "Scan for bugs and triage the most impactful ones.",
  },
  {
    key: "root_cause_engineer", name: "Root Cause Engineer", role: "Explains why failures happen",
    responsibilities: ["Trace call chains", "Correlate errors with code", "Rank root-cause hypotheses"],
    instructions: `${BASE}\nGiven a symptom, trace through callers and dependencies to the most likely root cause. Rank hypotheses with confidence and evidence.`,
    tools: [...READ_TOOLS, "record_hypothesis", "handoff"], limits: { maxSteps: 18, maxToolCalls: 35, timeoutSec: 900 },
    outputs: ["Root-cause analysis"],
    playbook: [{ tool: "search_code", input: (t) => ({ query: t, limit: 8 }) }, { tool: "list_findings", input: () => ({ severity: "high", limit: 20 }) }],
    defaultTask: "Identify the riskiest code paths and their likely failure modes.",
  },
  {
    key: "security_auditor", name: "Security Auditor", role: "Assesses security posture",
    responsibilities: ["Run security, secret and dependency scans", "Prioritise exploitable issues", "Recommend remediation"],
    instructions: `${BASE}\nYou assess security. Run scans, confirm findings by reading code, prioritise by exploitability and exposure.`,
    tools: [...READ_TOOLS, "run_scan", "dependency_report", "record_hypothesis"], limits: { maxSteps: 16, maxToolCalls: 30, timeoutSec: 1200 },
    outputs: ["Security assessment"],
    playbook: [{ tool: "run_scan", input: () => ({ kinds: ["security", "dependency"] }) }, { tool: "list_findings", input: () => ({ source: "security", limit: 25 }) }, { tool: "list_findings", input: () => ({ source: "secret", limit: 10 }) }, { tool: "list_findings", input: () => ({ source: "dependency", limit: 15 }) }],
    defaultTask: "Audit the repository's security posture and prioritise remediation.",
  },
  {
    key: "code_reviewer", name: "Code Reviewer", role: "Reviews code quality",
    responsibilities: ["Review modules for correctness and clarity", "Flag risky patterns", "Suggest concrete improvements"],
    instructions: `${BASE}\nYou review code like a senior engineer: correctness first, then security, performance, maintainability.`,
    tools: [...READ_TOOLS, "record_hypothesis"], limits: { maxSteps: 14, maxToolCalls: 25, timeoutSec: 900 },
    outputs: ["Review notes"],
    playbook: [{ tool: "list_findings", input: () => ({ limit: 30 }) }],
    defaultTask: "Review the most complex modules for correctness risks.",
  },
  {
    key: "test_engineer", name: "Test Engineer", role: "Improves test coverage",
    responsibilities: ["Find untested high-risk code", "Design test scenarios", "Generate and execute tests via Test Forge"],
    instructions: `${BASE}\nIdentify high-risk code with weak test coverage and queue Test Forge runs for the most valuable targets (max 3).`,
    tools: [...READ_TOOLS, "architecture_summary", "generate_tests"], limits: { maxSteps: 12, maxToolCalls: 20, timeoutSec: 600 },
    outputs: ["Test plan", "Queued Test Forge runs"],
    playbook: [{ tool: "repository_overview", input: () => ({}) }, { tool: "architecture_summary", input: () => ({}) }],
    defaultTask: "Find the riskiest untested code and propose tests.",
  },
  {
    key: "performance_engineer", name: "Performance Engineer", role: "Finds bottlenecks",
    responsibilities: ["Run performance analysis", "Identify N+1 queries, blocking I/O, quadratic loops", "Recommend optimisations"],
    instructions: `${BASE}\nFind performance problems from static evidence only. Never invent benchmark numbers.`,
    tools: [...READ_TOOLS, "run_scan", "record_hypothesis"], limits: { maxSteps: 14, maxToolCalls: 25, timeoutSec: 900 },
    outputs: ["Performance report"],
    playbook: [{ tool: "run_scan", input: () => ({ kinds: ["performance"] }) }, { tool: "list_findings", input: () => ({ source: "performance", limit: 25 }) }],
    defaultTask: "Identify the most significant performance risks.",
  },
  {
    key: "architecture_analyst", name: "Architecture Analyst", role: "Evaluates system design",
    responsibilities: ["Detect cycles and coupling", "Identify hotspots and isolated modules", "Recommend structural improvements"],
    instructions: `${BASE}\nEvaluate structure: layering, coupling, cycles, hotspots. Recommend specific refactors.`,
    tools: [...READ_TOOLS, "architecture_summary", "run_scan"], limits: { maxSteps: 12, maxToolCalls: 20, timeoutSec: 600 },
    outputs: ["Architecture assessment"],
    playbook: [{ tool: "architecture_summary", input: () => ({}) }, { tool: "run_scan", input: () => ({ kinds: ["debt"] }) }],
    defaultTask: "Assess the architecture and recommend structural improvements.",
  },
  {
    key: "dependency_analyst", name: "Dependency Analyst", role: "Manages third-party risk",
    responsibilities: ["Inventory dependencies", "Flag vulnerable/outdated/licensed packages", "Plan upgrades"],
    instructions: `${BASE}\nAnalyse dependencies: vulnerabilities, outdated majors, license risk, unused or duplicated packages. Produce an upgrade plan.`,
    tools: ["repository_overview", "dependency_report", "run_scan", "search_code", "list_findings"], limits: { maxSteps: 10, maxToolCalls: 15, timeoutSec: 900 },
    outputs: ["Dependency report", "Upgrade plan"],
    playbook: [{ tool: "run_scan", input: () => ({ kinds: ["dependency"] }) }, { tool: "dependency_report", input: () => ({}) }],
    defaultTask: "Review dependencies and produce an upgrade plan.",
  },
  {
    key: "documentation_agent", name: "Documentation Agent", role: "Writes documentation",
    responsibilities: ["Generate architecture docs", "Document APIs and models", "Save docs to the Knowledge Base"],
    instructions: `${BASE}\nWrite accurate developer documentation from the code, then save it with save_document. Do not document things you did not see.`,
    tools: [...READ_TOOLS, "architecture_summary", "save_document"], limits: { maxSteps: 16, maxToolCalls: 30, timeoutSec: 900 },
    outputs: ["Knowledge Base document"],
    playbook: [{ tool: "repository_overview", input: () => ({}) }, { tool: "architecture_summary", input: () => ({}) }],
    defaultTask: "Write architecture documentation for this repository.",
  },
];

export const agentByKey = (k: string) => AGENTS.find((a) => a.key === k);

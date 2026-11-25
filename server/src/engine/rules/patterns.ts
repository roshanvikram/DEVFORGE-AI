import type { RawFinding, Severity, Confidence, FindingSource } from "../types.js";

/**
 * Line-oriented pattern rules (security, secrets, insecure configuration).
 * These are deterministic: every finding cites the exact matching line.
 */
interface PatternRule {
  id: string;
  source: FindingSource;
  title: string;
  category: string;
  severity: Severity;
  confidence: Confidence;
  langs: string[] | "*";
  re: RegExp;
  /** optional: reject a match when this matches the same line */
  unless?: RegExp;
  explanation: string;
  impact: string;
  recommendation: string;
  verification: string;
  skipTests?: boolean;
}

const JS = ["typescript", "javascript", "vue", "svelte"];
const PY = ["python"];

export const PATTERN_RULES: PatternRule[] = [
  // ---------------- Injection ----------------
  {
    id: "sec/sql-injection-js", source: "security", title: "SQL built with string interpolation", category: "SQL injection", severity: "high", confidence: "medium", langs: JS,
    re: /\.(query|execute|raw|\$queryRawUnsafe|\$executeRawUnsafe|exec)\s*\(\s*(`[^`]*\b(SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)\b[^`]*\$\{|["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)\b[^"']*["']\s*\+)/i,
    explanation: "A SQL statement is assembled from interpolated values and passed directly to the driver.",
    impact: "If any interpolated value is user-controlled, an attacker can read or modify arbitrary data.",
    recommendation: "Use parameterised queries (placeholders such as `$1` / `?`) or the query builder's binding API.",
    verification: "Add a test passing `' OR 1=1 --` as input and assert it is treated as a literal.",
    skipTests: true,
  },
  {
    id: "sec/sql-injection-py", source: "security", title: "SQL built with string formatting", category: "SQL injection", severity: "high", confidence: "medium", langs: PY,
    re: /\.(execute|executemany|raw|text)\s*\(\s*(f["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)\b[^"']*\{|["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)\b[^"']*["']\s*(%|\.format\(|\+))/i,
    explanation: "A SQL statement is formatted with Python string interpolation before execution.",
    impact: "User-controlled values can alter the query structure (SQL injection).",
    recommendation: "Pass parameters separately: `cursor.execute(\"... WHERE id = %s\", (user_id,))`.",
    verification: "Test with a quote-containing input and confirm no syntax error / no extra rows.",
    skipTests: true,
  },
  {
    id: "sec/command-injection-js", source: "security", title: "Shell command built from dynamic input", category: "Command injection", severity: "high", confidence: "medium", langs: JS,
    re: /\b(exec|execSync|spawn|spawnSync)\s*\(\s*(`[^`]*\$\{|[^,)]*\+\s*\w)/,
    unless: /shell:\s*false/,
    explanation: "A shell command string is assembled from variables and passed to child_process.",
    impact: "Shell metacharacters in the input allow arbitrary command execution on the host.",
    recommendation: "Use `execFile`/`spawn` with an argument array and `shell: false`; validate inputs against an allowlist.",
    verification: "Pass `; touch /tmp/pwned` as input in a test and assert no file is created.",
    skipTests: true,
  },
  {
    id: "sec/command-injection-py", source: "security", title: "Shell execution with shell=True or os.system", category: "Command injection", severity: "high", confidence: "medium", langs: PY,
    re: /(\bos\.(system|popen)\s*\(|subprocess\.\w+\([^)]*shell\s*=\s*True)/,
    explanation: "Commands are executed through a shell interpreter.",
    impact: "If any part of the command is user-controlled, attackers can run arbitrary commands.",
    recommendation: "Use `subprocess.run([...], shell=False)` with an argument list.",
    verification: "Test with shell metacharacters in input.",
    skipTests: true,
  },
  {
    id: "sec/eval", source: "security", title: "Dynamic code evaluation", category: "Code injection", severity: "high", confidence: "medium", langs: [...JS, ...PY],
    re: /(^|[^.\w])(eval|exec)\s*\(|new\s+Function\s*\(/,
    unless: /\.exec\(|re\.exec|regex|RegExp|\bexec\s*\(\s*\)|cursor|conn|db\.|pool\.|knex|sql/i,
    explanation: "Strings are evaluated as code at runtime.",
    impact: "Untrusted input reaching eval/exec results in arbitrary code execution.",
    recommendation: "Replace with explicit parsing (JSON.parse / ast.literal_eval) or a dispatch table.",
    verification: "Confirm no user-controlled data flows into the evaluated string.",
    skipTests: true,
  },
  // ---------------- XSS ----------------
  {
    id: "sec/xss-dangerously-set-inner-html", source: "security", title: "dangerouslySetInnerHTML with dynamic content", category: "XSS", severity: "medium", confidence: "medium", langs: JS,
    re: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?!["'`])/,
    unless: /DOMPurify|sanitize/i,
    explanation: "Raw HTML is injected into the DOM from a non-literal value without visible sanitisation.",
    impact: "If the value contains attacker-controlled markup, scripts run in users' browsers (stored/reflected XSS).",
    recommendation: "Sanitise with DOMPurify (or equivalent) before rendering, or render as text.",
    verification: "Render `<img src=x onerror=alert(1)>` in a test and assert no script executes.",
  },
  {
    id: "sec/xss-inner-html", source: "security", title: "Assignment to innerHTML / document.write", category: "XSS", severity: "medium", confidence: "low", langs: JS,
    re: /(\.(innerHTML|outerHTML)\s*\+?=\s*(?!["'`]\s*["'`]?\s*;?$)|document\.write\s*\()/,
    unless: /DOMPurify|sanitize|= ?["'`][^$]*["'`];?\s*$/,
    explanation: "HTML is written into the DOM from code; non-constant values may contain markup.",
    impact: "Potential XSS if the value derives from user input.",
    recommendation: "Use `textContent`, or sanitise HTML before insertion.",
    verification: "Trace the data source of the assigned value.",
    skipTests: true,
  },
  {
    id: "sec/xss-template-safe", source: "security", title: "Auto-escaping disabled in template", category: "XSS", severity: "medium", confidence: "low", langs: ["python", "html", "vue"],
    re: /(\|\s*safe\b|mark_safe\s*\(|Markup\s*\(|v-html\s*=)/,
    explanation: "Template output is marked as safe HTML, bypassing auto-escaping.",
    impact: "XSS if the value contains user-controlled content.",
    recommendation: "Remove the safe marker or sanitise the value with bleach/DOMPurify first.",
    verification: "Render a payload containing `<script>` and assert it is escaped.",
  },
  // ---------------- Insecure configuration ----------------
  {
    id: "sec/tls-verification-disabled", source: "security", title: "TLS certificate verification disabled", category: "Insecure configuration", severity: "high", confidence: "high", langs: [...JS, ...PY],
    re: /(rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False)/,
    explanation: "Certificate validation is turned off for outbound HTTPS.",
    impact: "Connections are vulnerable to man-in-the-middle interception and tampering.",
    recommendation: "Remove the override; configure a custom CA bundle if needed.",
    verification: "Connect to a host with an invalid certificate and assert failure.",
    skipTests: true,
  },
  {
    id: "sec/cors-wildcard-credentials", source: "security", title: "Permissive CORS configuration", category: "Insecure configuration", severity: "medium", confidence: "medium", langs: [...JS, ...PY],
    re: /(origin\s*:\s*(['"]\*['"]|true)|Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*|allow_origins\s*=\s*\[\s*['"]\*['"])/,
    explanation: "Cross-origin requests are allowed from any origin.",
    impact: "Any website can call this API from a victim's browser; combined with credentials this exposes user data.",
    recommendation: "Restrict allowed origins to an explicit list.",
    verification: "Send a request with `Origin: https://evil.example` and assert it is rejected.",
    skipTests: true,
  },
  {
    id: "sec/debug-enabled", source: "security", title: "Debug mode enabled", category: "Insecure configuration", severity: "medium", confidence: "medium", langs: PY,
    re: /(\bDEBUG\s*=\s*True\b|\.run\([^)]*debug\s*=\s*True)/,
    explanation: "Framework debug mode is switched on in code.",
    impact: "Debug pages can leak stack traces, settings and secrets; Werkzeug's debugger allows code execution.",
    recommendation: "Read the flag from environment and default to False in production.",
    verification: "Check production configuration disables debug.",
    skipTests: true,
  },
  {
    id: "sec/weak-hash", source: "security", title: "Weak hash algorithm (MD5/SHA-1)", category: "Unsafe authentication", severity: "medium", confidence: "low", langs: [...JS, ...PY],
    re: /(createHash\(\s*['"](md5|sha1)['"]|hashlib\.(md5|sha1)\s*\()/i,
    unless: /usedforsecurity\s*=\s*False|etag|checksum|cache/i,
    explanation: "MD5/SHA-1 are cryptographically broken.",
    impact: "If used for passwords or signatures, attackers can forge or crack values.",
    recommendation: "Use SHA-256+ for integrity, and bcrypt/scrypt/argon2 for passwords.",
    verification: "Confirm the hash is not used for security decisions.",
    skipTests: true,
  },
  {
    id: "sec/insecure-random", source: "security", title: "Math.random used for security-sensitive value", category: "Unsafe authentication", severity: "medium", confidence: "medium", langs: JS,
    re: /(token|secret|password|nonce|salt|otp|session|apikey|api_key)\w*\s*[:=][^;\n]*Math\.random\(/i,
    explanation: "Math.random is not cryptographically secure and is predictable.",
    impact: "Tokens/secrets can be guessed.",
    recommendation: "Use `crypto.randomBytes` / `crypto.getRandomValues` / `crypto.randomUUID`.",
    verification: "Review generated token entropy.",
  },
  {
    id: "sec/jwt-none-or-no-verify", source: "security", title: "JWT verification weakened", category: "Unsafe authentication", severity: "high", confidence: "medium", langs: [...JS, ...PY],
    re: /(algorithms?\s*[:=]\s*\[?\s*['"]none['"]|jwt\.decode\([^)]*verify\s*=\s*False|options\s*=\s*\{[^}]*["']verify_signature["']\s*:\s*False|ignoreExpiration\s*:\s*true)/i,
    explanation: "JWT signature or expiry checks are disabled.",
    impact: "Attackers can forge tokens and impersonate users.",
    recommendation: "Always verify signatures with an explicit algorithm allowlist and enforce expiry.",
    verification: "Present an unsigned/expired token in a test and assert 401.",
  },
  {
    id: "sec/unsafe-deserialization", source: "security", title: "Unsafe deserialization", category: "Insecure deserialization", severity: "high", confidence: "medium", langs: PY,
    re: /(pickle\.loads?\s*\(|yaml\.load\s*\((?![^)]*Loader\s*=\s*(yaml\.)?(Safe|CSafe)Loader)|marshal\.loads\s*\()/,
    explanation: "Untrusted bytes are deserialised with a format that can instantiate arbitrary objects.",
    impact: "Remote code execution if the input is attacker-controlled.",
    recommendation: "Use `yaml.safe_load`, JSON, or a schema-validated format.",
    verification: "Confirm the input source is trusted or switch to a safe loader.",
    skipTests: true,
  },
  {
    id: "sec/path-traversal", source: "security", title: "File path derived from request input", category: "Unsafe file operations", severity: "high", confidence: "low", langs: [...JS, ...PY],
    re: /((sendFile|readFile|readFileSync|createReadStream|writeFile|unlink)\s*\([^)]*req\.(params|query|body)|open\s*\([^)]*request\.(args|form|GET|POST|query_params))/,
    explanation: "A filesystem path is built directly from request parameters.",
    impact: "Attackers can use `../` sequences to read or write files outside the intended directory.",
    recommendation: "Resolve the path, verify it stays within an allowed root, and reject path separators in identifiers.",
    verification: "Request `../../etc/passwd` and assert 400/404.",
  },
  {
    id: "sec/ssrf", source: "security", title: "Outbound request to user-supplied URL", category: "SSRF", severity: "medium", confidence: "low", langs: [...JS, ...PY],
    re: /((fetch|axios\.(get|post)|got|request|http\.get)\s*\(\s*req\.(query|body|params)|requests\.(get|post)\s*\(\s*request\.(args|form|json))/,
    explanation: "The server fetches a URL taken from the request.",
    impact: "Attackers can reach internal services or cloud metadata endpoints (SSRF).",
    recommendation: "Validate the URL against an allowlist and block private/link-local addresses after DNS resolution.",
    verification: "Request `http://169.254.169.254/` and assert it is refused.",
  },
];

// ---------------- Secrets ----------------
interface SecretRule { id: string; title: string; re: RegExp; severity: Severity; confidence: Confidence }
export const SECRET_RULES: SecretRule[] = [
  { id: "secret/aws-access-key", title: "AWS access key ID", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, severity: "critical", confidence: "high" },
  { id: "secret/github-token", title: "GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/, severity: "critical", confidence: "high" },
  { id: "secret/anthropic-key", title: "Anthropic API key", re: /\bsk-ant-(api|admin)\d{2}-[A-Za-z0-9_-]{40,}/, severity: "critical", confidence: "high" },
  { id: "secret/openai-key", title: "OpenAI-style API key", re: /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/, severity: "critical", confidence: "medium" },
  { id: "secret/slack-token", title: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, severity: "high", confidence: "high" },
  { id: "secret/stripe-live-key", title: "Stripe live secret key", re: /\b(sk|rk)_live_[A-Za-z0-9]{20,}/, severity: "critical", confidence: "high" },
  { id: "secret/google-api-key", title: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: "high", confidence: "high" },
  { id: "secret/private-key", title: "Private key block", re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/, severity: "critical", confidence: "high" },
  { id: "secret/jwt", title: "Hard-coded JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, severity: "medium", confidence: "medium" },
  { id: "secret/db-url-with-password", title: "Database URL with embedded password", re: /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^:\s/'"]+:[^@\s'"]{3,}@/, severity: "high", confidence: "medium" },
  {
    id: "secret/generic-assignment",
    title: "Hard-coded credential",
    re: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["'][^"'\s$<>{}]{8,}["']/i,
    severity: "high",
    confidence: "low",
  },
];
const PLACEHOLDER = /(example|changeme|change[_-]?me|your[_-]|xxx|placeholder|dummy|sample|test|fake|<|\$\{|process\.env|os\.environ|getenv|redacted|\*\*\*|abc123|password123|secret123)/i;

export function maskSecret(s: string): string {
  return s.replace(/([A-Za-z0-9_\-+/=]{4})([A-Za-z0-9_\-+/=]{6,})([A-Za-z0-9_\-+/=]{2})/g, (_m, a, mid, c) => a + "*".repeat(Math.min(mid.length, 12)) + c);
}

export function runPatternRules(file: { path: string; language: string | null; content: string; isTest: boolean }): RawFinding[] {
  const out: RawFinding[] = [];
  const lines = file.content.split("\n");
  const lang = file.language ?? "";
  const rules = PATTERN_RULES.filter((r) => (r.langs === "*" || r.langs.includes(lang)) && !(r.skipTests && file.isTest));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2000) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
    for (const r of rules) {
      if (!r.re.test(line)) continue;
      if (r.unless && r.unless.test(line)) continue;
      out.push({
        source: r.source, tool: "devforge-rules", rule_id: r.id, title: r.title, category: r.category, severity: r.severity, confidence: r.confidence,
        file_path: file.path, line: i + 1, snippet: lines.slice(Math.max(0, i - 1), i + 2).join("\n").slice(0, 600),
        evidence: `Line ${i + 1} matches rule ${r.id}: \`${trimmed.slice(0, 160)}\``,
        explanation: r.explanation, impact: r.impact, recommendation: r.recommendation, verification: r.verification,
      });
    }
  }
  return out;
}

export function runSecretRules(file: { path: string; content: string; isTest: boolean }): RawFinding[] {
  const out: RawFinding[] = [];
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum)$/.test(file.path)) return out;
  const isExample = /\.(example|sample|template|dist)$|example|\.md$/i.test(file.path);
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 3000) continue;
    for (const r of SECRET_RULES) {
      const m = line.match(r.re);
      if (!m) continue;
      if (r.id === "secret/generic-assignment" && (PLACEHOLDER.test(m[0]) || file.isTest)) continue;
      if (r.id === "secret/db-url-with-password" && PLACEHOLDER.test(m[0])) continue;
      const sev: Severity = isExample || file.isTest ? "low" : r.severity;
      out.push({
        source: "secret", tool: "devforge-secrets", rule_id: r.id, title: `${r.title} committed to repository`, category: "Exposed credentials",
        severity: sev, confidence: isExample ? "low" : r.confidence, file_path: file.path, line: i + 1,
        snippet: maskSecret(line.trim()).slice(0, 300),
        evidence: `Pattern for ${r.title} matched on line ${i + 1} (value masked).`,
        explanation: "A credential-like value is stored in source control. Anyone with read access to the repository (or its history) can use it.",
        impact: "Credential compromise; unauthorised access to the associated service. Rotation is required even after removal because the value stays in git history.",
        recommendation: "Revoke and rotate the credential, move it to a secrets manager or environment variable, and purge it from git history.",
        verification: "Confirm the old credential no longer authenticates and the file no longer contains it.",
      });
      break; // one secret finding per line
    }
  }
  return out;
}

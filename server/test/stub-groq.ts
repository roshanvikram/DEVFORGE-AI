import http from "node:http";

/** Local stand-in for Groq's OpenAI-compatible API. Records requests for assertions. */
export const GROQ_GOOD = "test-groq-valid-0001";
export const GROQ_RATE_LIMITED = "test-groq-ratelimited-0002";
/** A key whose account does not have the default model (llama-3.3-70b-versatile). */
export const GROQ_LIMITED = "test-groq-limited-0003";

export function startGroqStub(): Promise<{ url: string; requests: { path: string; headers: http.IncomingHttpHeaders; body: any }[]; close: () => Promise<void> }> {
  const requests: { path: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      const key = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (key === GROQ_RATE_LIMITED) return json(429, { error: { message: "Rate limit reached", type: "tokens" } });
      if (key !== GROQ_GOOD && key !== GROQ_LIMITED) return json(401, { error: { message: "Invalid API Key", type: "invalid_request_error", code: "invalid_api_key" } });
      const models = key === GROQ_LIMITED ? ["openai/gpt-oss-20b", "whisper-large-v3"] : ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "whisper-large-v3"];
      if (req.url === "/openai/v1/models") return json(200, { object: "list", data: models.map((id) => ({ id, active: true })) });
      if (!models.includes(body?.model)) return json(404, { error: { message: `The model \`${body?.model}\` does not exist or you do not have access to it.`, type: "invalid_request_error", code: "model_not_found" } });
      const usage = { prompt_tokens: 900, completion_tokens: 150, total_tokens: 1050 };
      const reply = (message: any, finish = "stop") => json(200, { id: "chatcmpl-stub", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], usage });
      // Structured output: DevForge puts the schema in the system prompt and asks for json_object.
      if (body.response_format?.type === "json_object") {
        return reply({ content: JSON.stringify({
          hypotheses: [{ title: "String-built SQL in find()", explanation: "The id is interpolated into SQL.", confidence: 0.8, evidence: ["src/db.ts:3"], files: ["src/db.ts"] }],
          proposed_fix: { summary: "Parameterise the query.", patch: "", tests: "Inject a quote and assert one row." },
        }) });
      }
      if (body.tools?.length) {
        const toolMsg = body.messages.find((m: any) => m.role === "tool");
        if (!toolMsg) return reply({ content: "Plan: list security findings.", tool_calls: [{ id: "call_stub_1", type: "function", function: { name: "list_findings", arguments: JSON.stringify({ source: "security" }) } }] }, "tool_calls");
        return reply({ content: `Groq summary: ${/sql-injection/.test(toolMsg.content) ? "SQL injection found in src/db.ts." : "no SQL injection."}` });
      }
      return reply({ content: "Groq says: `find` in `src/db.ts` queries users by id." });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as any;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) });
    }),
  );
}

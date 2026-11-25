import http from "node:http";

/**
 * Local stand-in for the Anthropic Messages API (streaming SSE), used to integration-test DevForge's
 * AI code paths without network access or a real key. It records every request so tests can assert
 * on exactly what DevForge sends (model, tools, schema, size of code context, auth header).
 */
export type Recorded = { path: string; headers: http.IncomingHttpHeaders; body: any };
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

export const GOOD_KEY = "test-key-valid-0001";
export const BAD_KEY = "test-key-revoked-0002";
export const NO_CREDIT_KEY = "test-key-nocredit-0003";

function sse(res: http.ServerResponse, blocks: Block[], stop: string) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const chunk of b.text.match(/.{1,40}/gs) ?? []) send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } });
    } else {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    send("content_block_stop", { type: "content_block_stop", index });
  });
  send("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 300 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

export function startStub(): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      // Current SDKs send the key as a Bearer token; direct fetches use x-api-key. Accept both.
      const key = req.headers["x-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (key === NO_CREDIT_KEY && req.url?.startsWith("/v1/messages")) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } }));
      }
      if (key !== GOOD_KEY && key !== NO_CREDIT_KEY) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      }
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "claude-opus-5-5", type: "model" }], has_more: false }));
      }
      // Structured output (investigations): return schema-conformant JSON citing a real repo file.
      if (body?.output_config?.format?.type === "json_schema") {
        return sse(res, [{ type: "text", text: JSON.stringify({
          hypotheses: [
            { title: "Unvalidated id interpolated into SQL", explanation: "find() builds SQL with a template literal from the id argument.", confidence: 0.82, evidence: ["src/db.ts:3"], files: ["src/db.ts"] },
            { title: "Invented module", explanation: "Cites a file that does not exist.", confidence: 0.2, evidence: ["src/ghost.ts:1"], files: ["src/ghost.ts"] },
          ],
          proposed_fix: { summary: "Use a parameterised query.", patch: "--- a/src/db.ts\n+++ b/src/db.ts\n@@\n-  return db.query(`SELECT * FROM users WHERE id = ${id}`);\n+  return db.query(\"SELECT * FROM users WHERE id = ?\", [id]);", tests: "Call find() with \"1 OR 1=1\" and assert a single row." },
        }) }], "end_turn");
      }
      // Agent tool loop: first turn plans + calls a real tool; second turn reports using the tool result.
      if (body?.tools?.length) {
        const sawResult = body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result"));
        if (!sawResult) return sse(res, [{ type: "text", text: "Plan: list open security findings, then summarise." }, { type: "tool_use", id: "toolu_stub_1", name: "list_findings", input: { source: "security" } }], "tool_use");
        const result = body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).find((c: any) => c.type === "tool_result");
        const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
        return sse(res, [{ type: "text", text: `## Security summary\nTool result received (${text.length} chars). ${/sql-injection/.test(text) ? "SQL injection is present in src/db.ts." : "No SQL injection reported."}` }], "end_turn");
      }
      // Plain completion (repository Q&A).
      return sse(res, [{ type: "text", text: "The `find` function in `src/db.ts:2` queries users by id." }], "end_turn");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as any;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) });
    }),
  );
}

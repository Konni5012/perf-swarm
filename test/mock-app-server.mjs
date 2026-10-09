import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const response = (id, result) => send({ id, result });
const notification = (method, params) => send({ method, params });
let nextThread = 0, nextTurn = 0, call = 1000;
const threads = new Map(), pending = new Map();
let lastStart, lastTurn, lastSteer, interrupts = 0, lastApproval, computerCleanup = [], mcpConnected = true;
function finish(threadId, turnId, text) {
  const thread = threads.get(threadId);
  thread.tokens += 7;
  notification("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: { totalTokens: thread.tokens } } });
  notification("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: { totalTokens: thread.tokens } } });
  notification("item/agentMessage/delta", { threadId, turnId, itemId: turnId + "-message", delta: text });
  notification("item/completed", { threadId, turnId, item: { type: "agentMessage", id: turnId + "-message", text } });
  notification("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line), p = m.params;
  if (!m.method) {
    const waiting = pending.get(m.id);
    if (!waiting) return;
    pending.delete(m.id);
    if (waiting.approval) { lastApproval = m.result ?? m.error; return; }
    finish(waiting.threadId, waiting.turnId, JSON.stringify(m.result));
    return;
  }
  if (m.method === "initialize") return response(m.id, { serverInfo: {} });
  if (m.method === "initialized") return;
  if (m.method === "config/read") return response(m.id, { config: { mcp_servers: { private_server: { enabled: true } } } });
  if (m.method === "account/read") return response(m.id, { account: { type: "chatgpt" } });
  if (m.method === "model/list") return response(m.id, { data: [{ model: "test-model" }], nextCursor: null });
  if (m.method === "test/state") return response(m.id, { lastStart, lastTurn, lastSteer, interrupts, lastApproval, computerCleanup });
  if (m.method === "test/mcp-status") { mcpConnected = p.connected; return response(m.id, {}); }
  if (m.method === "mcpServerStatus/list") return response(m.id, { data: [{ name: "cua_repl", runtimeStatus: mcpConnected ? "connected" : "failed", tools: mcpConnected ? { js: {}, js_reset: {} } : {} }] });
  if (m.method === "mcpServer/tool/call") {
    if (p.tool === "turn_ended") computerCleanup.push(p);
    return response(m.id, { result: { content: p.tool === "js" ? [{ text: JSON.stringify({ browsers: [] }) }] : [] } });
  }
  if (m.method === "test/late-usage") {
    const thread = threads.get(p.threadId);
    thread.tokens += 3;
    notification("thread/tokenUsage/updated", { threadId: p.threadId, turnId: p.turnId, tokenUsage: { total: { totalTokens: thread.tokens } } });
    return response(m.id, {});
  }
  if (m.method === "test/exit") return process.exit(3);
  if (m.method === "test/hang") return;
  if (m.method === "test/malformed") return process.stdout.write("invalid json\n");
  if (m.method === "thread/start" || m.method === "thread/resume") {
    const id = p.threadId ?? `thread-${++nextThread}`;
    if (!threads.has(id)) threads.set(id, { tokens: 0 });
    lastStart = p;
    return response(m.id, { thread: { id }, model: p.model, approvalPolicy: p.model === "unsafe" ? "never" : p.approvalPolicy, approvalsReviewer: p.approvalsReviewer, sandbox: { type: p.sandbox === "read-only" ? "readOnly" : "workspaceWrite" } });
  }
  if (m.method === "thread/unsubscribe") return response(m.id, {});
  if (m.method === "turn/steer") { lastSteer = p; return response(m.id, {}); }
  if (m.method === "turn/interrupt") { interrupts++; response(m.id, {}); notification("turn/completed", { threadId: p.threadId, turn: { id: p.turnId, status: "interrupted" } }); return; }
  if (m.method === "turn/start") {
    lastTurn = p;
    const turnId = `turn-${++nextTurn}`;
    const begin = () => {
      notification("turn/started", { threadId: p.threadId, turn: { id: turnId } });
      response(m.id, { turn: { id: turnId } });
      const mode = p.input[0].text;
      if (mode === "slowStart" || mode === "hang") return;
      if (mode === "crash") return process.exit(4);
      if (mode === "approval") {
        const id = ++call; pending.set(id, { approval: true });
        return send({ id, method: "item/commandExecution/requestApproval", params: { threadId: p.threadId, turnId, reason: "Human approval required" } });
      }
      if (mode.startsWith("tool")) {
        const id = ++call; pending.set(id, { threadId: p.threadId, turnId });
        return send({ id, method: "item/tool/call", params: { threadId: p.threadId, turnId, callId: "call", namespace: null, tool: mode === "tool-unavailable" ? "subagent" : "effect", arguments: mode === "tool-invalid" ? { n: "invalid" } : { n: 3 } } });
      }
      if (mode === "review") notification("item/autoApprovalReview/completed", { threadId: p.threadId, turnId, review: { status: "denied", rationale: "External publication was not authorized" } });
      finish(p.threadId, turnId, "Codex completed");
    };
    if (p.input[0].text === "slowStart") setTimeout(begin, 80); else begin();
    return;
  }
  send({ id: m.id, error: { code: -32601, message: "Unknown method" } });
});

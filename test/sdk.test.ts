import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { AppServer } from "../src/protocol.js";
import { CodexDriver, defineTool, NATIVE_CONFIG, validateModels } from "../src/driver.js";
import { config } from "./helpers.js";
import type { TelemetryEvent } from "../src/types.js";

async function setup() {
  const server = new AppServer(process.execPath, [fileURLToPath(new URL("./mock-app-server.mjs", import.meta.url))]);
  await server.initialize();
  return { server, driver: new CodexDriver(server, config(1)) };
}
function options() { return { id: "worker-1234", model: "test-model", workspace: "/tmp/worker-1234", system: "You are worker-1234", tools: [], onUsage: (_tokens: number) => {} }; }
test("native telemetry records turn boundaries and deduplicated usage, including interrupts", async () => {
  const {server,driver}=await setup(); const events:TelemetryEvent[]=[];
  try{
    const handle=await driver.create({...options(),onTelemetry:event=>events.push(event)});
    await handle.prompt("work");
    const running=handle.prompt("hang");void running.catch(()=>{});
    await waitFor(async()=>events.filter(e=>e.kind==="turn-start").length===2);
    await handle.abort();await assert.rejects(()=>running);handle.dispose();
    assert.equal(events.filter(e=>e.kind==="turn-start").length,2);
    assert.equal(events.filter(e=>e.kind==="turn-end").length,2);
    assert.equal(events.filter(e=>e.kind==="usage").reduce((n,e)=>n+(e.tokens??0),0),7);
    assert.equal(events.find(e=>e.kind==="item-end")?.itemType,"agentMessage");
    assert.equal(events.at(-1)!.status,"interrupted");assert.ok(events.every(e=>e.actor==="worker-1234"));
  }finally{server.dispose();}
});
test("late token updates retain the completed native turn attribution", async () => {
  const { server, driver } = await setup();
  const events: TelemetryEvent[] = [];
  let threadId = "";
  try {
    const handle = await driver.create({ ...options(), onSession: id => { threadId = id; }, onTelemetry: event => events.push(event) });
    await handle.prompt("work");
    const turnId = events.find(event => event.kind === "turn-start")!.turnId;
    await server.request("test/late-usage", { threadId, turnId });
    assert.equal(events.at(-1)!.kind, "usage");
    assert.equal(events.at(-1)!.turnId, turnId);
    assert.equal(events.at(-1)!.tokens, 3);
    handle.dispose();
  } finally { server.dispose(); }
});
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("Timed out");
}
test("Codex stdio protocol streams text, scopes dynamic tools, accounts cumulative usage once and resumes", async () => {
  const { server, driver } = await setup();
  let effects = 0, tokens = 0, accounted = 0, saved = "", text = "";
  const effect = defineTool({ name: "effect", description: "Test effect", parameters: Type.Object({ n: Type.Integer() }), execute: async (_id, args) => { effects += args.n; return { content: [{ type: "text", text: "Effect happened" }] }; } });
  const opts = { ...options(), tools: [effect], onSession: (id: string) => { saved = id; }, onUsage: (n: number) => { tokens += n; }, onTotalUsage: (n: number) => { accounted = n; }, onText: (delta: string) => { text += delta; } };
  try {
    const first = await driver.create(opts);
    assert.match(await first.prompt("tool"), /Effect happened/);
    assert.equal(effects, 3); assert.equal(tokens, 7); assert.equal(accounted, 7); assert.match(text, /Effect happened/);
    assert.match(await first.prompt("tool-invalid"), /Invalid tool arguments/);
    assert.match(await first.prompt("tool-unavailable"), /Tool unavailable/);
    assert.equal(effects, 3); assert.equal(tokens, 21);
    first.dispose();
    const resumed = await driver.create({ ...opts, threadId: saved, accountedTokens: accounted });
    assert.equal(await resumed.prompt("continue"), "Codex completed");
    assert.equal(tokens, 28); assert.equal(accounted, 28);
    resumed.dispose();
    const state = await server.request("test/state", {});
    assert.equal(state.lastStart.threadId, saved);
    assert.equal(state.lastStart.approvalPolicy, "on-request");
    assert.equal(state.lastStart.approvalsReviewer, "auto_review");
    assert.equal(state.lastStart.sandbox, "workspace-write");
    assert.equal(state.lastStart.config["mcp_servers.private_server.enabled"], false);
    for (const [key, value] of Object.entries(NATIVE_CONFIG)) assert.deepEqual(state.lastStart.config[key], value);
    assert.deepEqual(state.lastTurn.sandboxPolicy.writableRoots, [opts.workspace]);
    assert.equal(state.lastTurn.sandboxPolicy.networkAccess, false);
    await validateModels(server, ["test-model"]);
    await assert.rejects(() => validateModels(server, ["invented-model"]), /Unknown Codex model/);
  } finally { server.dispose(); }
});
test("native policy mismatch fails safely; auditor uses read-only; integrator cwd changes per turn", async () => {
  const { server, driver } = await setup();
  try {
    await assert.rejects(() => driver.create({ ...options(), model: "unsafe" }), /required native sandbox/);
    const audit = await driver.create({ ...options(), readOnly: true });
    await audit.prompt("inspect");
    assert.deepEqual((await server.request("test/state", {})).lastTurn.sandboxPolicy, { type: "readOnly", networkAccess: false });
    audit.dispose();
    let workspace = options().workspace;
    const worker = await driver.create({ ...options(), currentWorkspace: () => workspace });
    await worker.prompt("work"); workspace = "/tmp/integration"; await worker.prompt("combine");
    const state = await server.request("test/state", {});
    assert.equal(state.lastTurn.cwd, workspace); assert.deepEqual(state.lastTurn.sandboxPolicy.writableRoots, [workspace]); worker.dispose();
  } finally { server.dispose(); }
});
test("approval requests reaching the host are declined and reported, never silently approved", async () => {
  const { server, driver } = await setup(); let reason = "";
  try {
    const worker = await driver.create({ ...options(), onApprovalRequired: (message) => { reason = message; } });
    await assert.rejects(() => worker.prompt("approval"), /operator input/);
    assert.match(reason, /Human approval required/);
    await waitFor(async () => (await server.request("test/state", {})).lastApproval?.decision === "decline");
    worker.dispose();
  } finally { server.dispose(); }
});
test("steering and interrupts work, including interruption while turn/start is pending", async () => {
  const { server, driver } = await setup();
  try {
    const worker = await driver.create(options());
    const running = worker.prompt("hang"); void running.catch(() => {});
    await waitFor(async () => Boolean((await server.request("test/state", {})).lastTurn));
    assert.equal(await worker.steer("new user instruction"), true);
    assert.equal((await server.request("test/state", {})).lastSteer.input[0].text, "new user instruction");
    await worker.abort(); await assert.rejects(() => running, /interrupted/);
    assert.equal(await worker.steer("no active turn"), false); worker.dispose();
    const slow = await driver.create(options());
    const starting = slow.prompt("slowStart"); void starting.catch(() => {});
    await slow.abort(); await assert.rejects(() => starting, /interrupted/);
    await waitFor(async () => (await server.request("test/state", {})).interrupts === 2);
    slow.dispose();
  } finally { server.dispose(); }
});
test("server exit rejects active turns and pending RPC; timeouts and malformed output fail safely", async () => {
  const { server, driver } = await setup();
  try {
    await assert.rejects(() => server.request("test/hang", {}, 20), /timed out/);
    const worker = await driver.create(options());
    await assert.rejects(() => worker.prompt("crash"), /app-server exited/);
    worker.dispose();
    await assert.rejects(() => server.request("model/list", {}), /closed/);
  } finally { server.dispose(); }
  const second = await setup();
  try { await assert.rejects(() => second.server.request("test/malformed", {}), /invalid JSON/); }
  finally { second.server.dispose(); }
});

test("native automatic reviewer denial rationale reaches the operator callback", async () => {
  const { server, driver } = await setup(); const reviews: string[] = [];
  try {
    const worker = await driver.create({ ...options(), onReview: (status, reason) => reviews.push(`${status}: ${reason}`) });
    await worker.prompt("review");
    assert.deepEqual(reviews, ["denied: External publication was not authorized"]);
    worker.dispose();
  } finally { server.dispose(); }
});

test("steering received during startup waits for the native turn ID", async () => {
  const { server, driver } = await setup();
  try {
    const worker = await driver.create(options());
    const starting = worker.prompt("slowStart"); void starting.catch(() => {});
    await worker.steer("instruction while starting");
    assert.equal((await server.request("test/state", {})).lastSteer.input[0].text, "instruction while starting");
    await worker.abort(); await assert.rejects(() => starting, /interrupted/); worker.dispose();
  } finally { server.dispose(); }
});

test("per-model reasoning and disabled web tools apply to both thread and turn", async () => {
  const { server } = await setup();
  try {
    const driver = new CodexDriver(server, { ...config(4), modelThinking: { "gpt-6-luna": "max", "gpt-6.1-sol": "low" }, webSearch: false });
    for (const [model, effort] of [["gpt-6-luna", "max"], ["gpt-6.1-sol", "low"]]) {
      const worker = await driver.create({ ...options(), model });
      await worker.prompt("work");
      const state = await server.request("test/state", {});
      assert.equal(state.lastStart.config.model_reasoning_effort, effort);
      assert.equal(state.lastTurn.effort, effort);
      assert.equal(state.lastStart.config.web_search, "disabled");
      assert.equal(state.lastStart.config["tools.web_search"], false);
      assert.equal(state.lastStart.config["features.browser_use"], false);
      worker.dispose();
    }
  } finally { server.dispose(); }
});

test("dynamic screenshots use native inputImage content, never base64 text", async () => {
  const { server, driver } = await setup();
  const url = "data:image/png;base64,iVBORw0KGgo=";
  try {
    const effect = defineTool({ name: "effect", description: "Image transport fixture", parameters: Type.Object({ n: Type.Integer() }), execute: async () => ({ content: [{ type: "text", text: "Screenshot metadata" }, { type: "image", imageUrl: url }] }) });
    const handle = await driver.create({ ...options(), tools: [effect] });
    const response = JSON.parse(await handle.prompt("tool"));
    assert.deepEqual(response.contentItems, [{ type: "inputText", text: "Screenshot metadata" }, { type: "inputImage", imageUrl: url }]);
    handle.dispose();
  } finally { server.dispose(); }
});

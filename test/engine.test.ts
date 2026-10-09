import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDriver, AgentHandle, AgentOptions } from "../src/driver.js";
import { Engine } from "../src/engine.js";
import { fixture } from "./helpers.js";

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("Timed out waiting for test condition.");
}
async function call(options: AgentOptions, name: string, args: unknown) {
  const tool = options.tools.find((tool) => tool.name === name);
  assert.ok(tool, `${name} is available`);
  return tool.execute("fake-call", args);
}
function driver(handler: (options: AgentOptions, prompt: string) => Promise<string>): AgentDriver {
  return { create: async (options): Promise<AgentHandle> => ({ prompt: (text) => handler(options, text), steer: async () => false, abort: async () => {}, dispose: () => {} }) };
}
test("end-to-end: parent-only helper, artifact integration, tap-out without independent audit", { timeout: 10000 }, async () => {
  const f = await fixture(1);
  const captured: AgentOptions[] = [];
  const turns = new Map<string, number>();
  let audits = 0;
  try {
    const engine = new Engine(f.store, driver(async (options, prompt) => {
      captured.push(options);
      options.onUsage(2);
      if (options.id.includes("/sub-")) {
        assert.equal(options.model, "helper-secret");
        assert.ok(options.tools.every((tool) => !["board", "dm", "subagent", "audit", "swarm_status"].includes(tool.name)));
        await writeFile(join(options.workspace, "report.txt"), "hello\n");
        return "report.txt contains hello";
      }
      if (options.id.startsWith("auditor-")) {
        audits++;
        assert.ok(options.workspace !== f.store.state.integration);
        assert.equal(options.readOnly, true);
        const content = await readFile(join(options.workspace, "report.txt"), "utf8");
        assert.match(JSON.stringify(content), /hello/);
        return '{"done":true,"reason":"Independently read report.txt and verified hello"}';
      }
      const turn = (turns.get(options.id) ?? 0) + 1;
      turns.set(options.id, turn);
      assert.doesNotMatch(options.system + prompt, /assigned-secret|helper-secret|audit-secret/);
      if (turn === 1) {
        await call(options, "subagent", { action: "spawn", task: "Write report.txt containing hello" });
        return "Waiting for my helper";
      }
      assert.doesNotMatch(prompt, /report.txt contains hello/);
      const status = await call(options, "swarm_status", {});
      assert.match(status.content[0]!.text, /report.txt contains hello/);
      await call(options, "integrator", { action: "claim" });
      await call(options, "integrate", { action: "publish", worker: options.id, path: "report.txt", destination: "report.txt" });
      await call(options, "tap_out", { outcome: "complete", reason: "Integrated report.txt; helper verified hello" });
      return "Ready for audit";
    }));
    await engine.run();
    assert.equal(f.store.state.status, "completed");
    assert.equal(audits, 0);
    assert.equal(f.store.state.outcome?.status, "complete");
    assert.equal(f.store.state.children[0]!.status, "completed");
    assert.equal(await readFile(join(f.store.state.integration, "report.txt"), "utf8"), "hello\n");
    assert.ok(f.store.state.tokens > 0);
    assert.equal(captured.filter((options) => options.id.includes("/sub-")).length, 1);
  } finally { await f.cleanup(); }
});
test("crashed workers get exactly three restarts and then pause", { timeout: 12000 }, async () => {
  const f = await fixture(1);
  try {
    let attempts = 0;
    const engine = new Engine(f.store, driver(async () => { attempts++; throw new Error("Transient fault"); }));
    await engine.run();
    assert.equal(attempts, 4);
    assert.equal(f.store.state.status, "paused");
    assert.match(f.store.state.pauseReason!, /3 restarts/);
    assert.equal(f.store.worker("worker-0001").status, "failed");
  } finally { await f.cleanup(); }
});
test("paused child work and votes survive resume without creating extra workers", { timeout: 10000 }, async () => {
  const f = await fixture(1);
  try {
    const id = f.store.reserveChild("worker-0001", "Recover this task");
    f.store.update((state) => { state.status = "paused"; state.children[0]!.status = "running"; });
    let resumed = false;
    const engine = new Engine(f.store, driver(async (options) => {
      if (options.id === id) { resumed = true; return "Recovered result"; }
      if (options.id.startsWith("auditor-")) return '{"done":true,"reason":"Verified"}';
      if (!resumed) return "Waiting";
      await call(options, "tap_out", { outcome: "complete", reason: "Helper recovered" });
      return "Done";
    }));
    await engine.run();
    assert.ok(resumed);
    assert.equal(f.store.state.workers.length, 1);
    assert.equal(f.store.state.children[0]!.result, "Recovered result");
  } finally { await f.cleanup(); }
});
test("runtime limit pauses in-flight work and preserves state", { timeout: 5000 }, async () => {
  const f = await fixture(1);
  try {
    f.store.update((state) => { state.config.maxRuntimeMs = 50; });
    let interrupted = false;
    let finish: ((value: string) => void) | undefined;
    const fake: AgentDriver = { create: async () => ({ prompt: () => new Promise((resolve) => { finish = resolve; }), steer: async () => false, abort: async () => { interrupted = true; finish?.("Interrupted"); }, dispose: () => {} }) };
    const engine = new Engine(f.store, fake);
    await engine.run();
    assert.ok(interrupted);
    assert.equal(f.store.state.status, "paused");
    assert.match(f.store.state.pauseReason!, /Runtime budget/);
    assert.ok(f.store.state.elapsedMs >= 50);
  } finally { await f.cleanup(); }
});
test("user DMs steer an active worker without exposing other workers' private messages or model assignments", { timeout: 5000 }, async () => {
  const f = await fixture(1);
  let started = false;
  let finish: ((output: string) => void) | undefined;
  const updates: string[] = [];
  const fake: AgentDriver = { create: async () => ({
    prompt: () => new Promise((resolve) => { started = true; finish = resolve; }),
    steer: async (text) => { updates.push(text); return true; },
    abort: async () => { finish?.("Stopped"); }, dispose: () => {},
  }) };
  const engine = new Engine(f.store, fake);
  const running = engine.run();
  try {
    await waitFor(() => started);
    f.store.dm("user", "worker-0001", "Prioritize the comparison");
    engine.wake("worker-0001");
    await waitFor(() => updates.length > 0);
    assert.match(updates[0]!, /Prioritize the comparison/);
    assert.doesNotMatch(updates[0]!, /assigned-secret|helper-secret|audit-secret/);
  } finally { await engine.pause(); await running; await f.cleanup(); }
});
test("a cancelled helper still occupies a slot until its startup has stopped", { timeout: 5000 }, async () => {
  const f = await fixture(1);
  const ids = Array.from({ length: 4 }, (_, i) => f.store.reserveChild("worker-0001", `job ${i}`));
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let startups = 0;
  const calls: string[] = [];
  const fake: AgentDriver = { create: async (options) => {
    if (options.id.includes("/sub-")) { startups++; await barrier; }
    return { prompt: async () => { calls.push(options.id); return "Finished"; }, steer: async () => false, abort: async () => {}, dispose: () => {} };
  } };
  const engine = new Engine(f.store, fake);
  const running = engine.run();
  try {
    await waitFor(() => startups === 4);
    await engine.cancelChild(ids[0]!);
    assert.equal(f.store.state.children[0]!.status, "cancelling");
    assert.throws(() => f.store.reserveChild("worker-0001", "fifth"), /four active/);
    release!();
    await waitFor(() => f.store.state.children[0]!.status === "cancelled");
    assert.ok(!calls.includes(ids[0]!));
    assert.doesNotThrow(() => f.store.reserveChild("worker-0001", "replacement"));
  } finally { release!(); await engine.pause(); await running; await f.cleanup(); }
});

test("integrator switches native workspace on the following turn, then votes after verification", { timeout: 5000 }, async () => {
  const f = await fixture(1); let turns = 0;
  try {
    const engine = new Engine(f.store, driver(async (options) => {
      if (options.id.startsWith("auditor-")) return '{"done":true,"reason":"Verified integration"}';
      turns++;
      if (turns === 1) {
        assert.equal(options.currentWorkspace!(), options.workspace);
        assert.ok(!options.tools.some((tool) => ["bash", "exec", "read", "write"].includes(tool.name)));
        await call(options, "integrator", { action: "claim" });
        await call(options, "integrate", { action: "workspace", target: "integration" });
        engine.wake(options.id);
        return "Switched, ending turn";
      }
      assert.equal(options.currentWorkspace!(), f.store.state.integration);
      await writeFile(join(options.currentWorkspace!(), "report.txt"), "hello");
      await call(options, "tap_out", { outcome: "complete", reason: "Verified combined output" });
      return "Ready";
    }));
    await engine.run();
    assert.equal(turns, 2); assert.equal(f.store.state.status, "completed");
  } finally { await f.cleanup(); }
});
test("native operator approval requirement pauses the swarm with the reported reason", async () => {
  const f = await fixture(1);
  try {
    const engine = new Engine(f.store, driver(async (options) => {
      options.onApprovalRequired?.("Codex requires human approval for publication");
      return "Waiting";
    }));
    await engine.run();
    assert.equal(f.store.state.status, "paused");
    assert.match(f.store.state.pauseReason!, /human approval for publication/);
  } finally { await f.cleanup(); }
});

test("reported worker tokens pause before any further coordination tool side effects", async () => {
  const f = await fixture(1);
  try {
    f.store.update((state) => { state.config.maxTokens = 5; });
    const engine = new Engine(f.store, driver(async (options) => {
      options.onUsage(5);
      await assert.rejects(() => call(options, "board", { action: "post", text: "Must not execute" }), /paused/);
      return "Stopped";
    }));
    await engine.run();
    assert.equal(f.store.state.tokens, 5); assert.equal(f.store.state.status, "paused");
    assert.ok(!f.store.state.board.some((post) => post.text === "Must not execute"));
  } finally { await f.cleanup(); }
});

test("persistent workers pull coordination without snapshot prompts or routine steering", { timeout: 5000 }, async () => {
  const f = await fixture(2);
  const prompts: string[] = [], updates: string[] = [];
  let opens = 0;
  const fake: AgentDriver = { create: async options => {
    opens++;
    assert.match(options.system, /Original user objective/);
    assert.match(options.system, /Produce report.txt containing hello/);
    return { prompt: async text => {
      prompts.push(text);
      if (options.id === "worker-0001" && prompts.length === 1) {
        const posted = await call(options, "board", { action: "post", text: "Shared coordination stays on the board" });
        assert.deepEqual(Object.keys(JSON.parse(posted.content[0]!.text)).sort(), ["at", "id"]);
        const sent = await call(options, "dm", { action: "send", to: "worker-0002", text: "Pull this DM" });
        assert.deepEqual(Object.keys(JSON.parse(sent.content[0]!.text)).sort(), ["at", "id", "status", "to"]);
      }
      const board = await call(options, "board", { action: "read", limit: 1 });
      assert.match(board.content[0]!.text, /Shared coordination/);
      if (options.id === "worker-0002") {
        const inbox = await call(options, "dm", { action: "read", limit: 1 });
        assert.match(inbox.content[0]!.text, /Pull this DM/);
      }
      return "Continuing the task";
    }, steer: async text => { updates.push(text); return true; }, abort: async () => {}, dispose: () => {} };
  } };
  const engine = new Engine(f.store, fake), running = engine.run();
  try {
    await waitFor(() => prompts.length >= 2);
    assert.equal(opens, 2);
    assert.ok(prompts.every(prompt => prompt.length < 200));
    assert.doesNotMatch(prompts.join("\n"), /Produce report|Shared coordination|Pull this DM|\"board\"|\"tasks\"/);
    assert.ok(updates.every(text => text.startsWith("Coordination notification:") && !text.includes("Pull this DM")));
  } finally { await engine.pause(); await running; await f.cleanup(); }
});

test("subscriptions end the turn immediately and only selected task completion wakes it", { timeout: 5000 }, async () => {
  const f = await fixture(2); let calls = 0;
  const task = f.store.task("worker-0002", "create", { title: "Dependency" });
  f.store.task("worker-0002", "claim", { id: task.id });
  const engine = new Engine(f.store, driver(async options => {
    if (options.id === "worker-0002") { await call(options, "swarm_sleep", {}); return "Parked"; }
    calls++; await call(options, "swarm_wait", { tasks: [task.id], generation: false, dms: false }); return "Subscribed";
  }));
  const running = engine.run();
  try {
    await waitFor(() => calls === 1 && f.store.worker("worker-0001").parked === true);
    f.store.post("worker-0002", "Routine finding"); engine.notify("board", "worker-0002");
    await new Promise(resolve => setTimeout(resolve, 600)); assert.equal(calls, 1);
    f.store.task("worker-0002", "complete", { id: task.id, result: "Dependency ready" }); engine.notify("task", "worker-0002", task.id);
    await waitFor(() => calls === 2);
  } finally { await engine.pause(); await running; await f.cleanup(); }
});

test("operator steering sends only new relevant messages and persists delivery", { timeout: 5000 }, async () => {
  const f = await fixture(2);
  let started = 0;
  const updates: { id: string; text: string }[] = [], finishers: (() => void)[] = [];
  const fake: AgentDriver = { create: async options => ({
    prompt: () => new Promise(resolve => { started++; finishers.push(() => resolve("Stopped")); }),
    steer: async text => { updates.push({ id: options.id, text }); return true; },
    abort: async () => { finishers.forEach(finish => finish()); }, dispose: () => {},
  }) };
  const engine = new Engine(f.store, fake), running = engine.run();
  try {
    await waitFor(() => started === 2);
    f.store.post("worker-0001", "Routine board chatter"); engine.wakeAll();
    f.store.dm("worker-0001", "worker-0002", "Private teammate DM"); engine.wake("worker-0002");
    const message = f.store.dm("user", "worker-0001", "Operator correction"); engine.wakeAll();
    await waitFor(() => updates.some(update => update.text.includes("Operator correction")));
    const operator = updates.filter(update => update.text.includes("Operator correction"));
    assert.equal(operator[0]!.id, "worker-0001");
    assert.doesNotMatch(operator[0]!.text, /Routine board|Private teammate|Produce report|assigned-secret/);
    assert.ok(updates.filter(update => update.id === "worker-0002").every(update => update.text.startsWith("Coordination notification:") && !update.text.includes("Private teammate DM")));
    await waitFor(() => f.store.worker("worker-0001").deliveredUserMessageId === message.id);
    engine.wakeAll();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(updates.filter(update => update.text.includes("Operator correction")).length, 1);
    assert.equal(f.store.worker("worker-0002").deliveredUserMessageId, undefined);
  } finally { await engine.pause(); await running; await f.cleanup(); }
});

test("an operator instruction is retained when the native turn finishes before steering", { timeout: 5000 }, async () => {
  const f = await fixture(1);
  let prompts = 0, finish: ((text: string) => void) | undefined, retried = "";
  const fake: AgentDriver = { create: async () => ({
    prompt: text => {
      prompts++;
      if (prompts === 1) return new Promise(resolve => { finish = resolve; });
      retried = text;
      return new Promise(resolve => { finish = resolve; });
    },
    steer: async () => { finish?.("Turn already finished"); return false; },
    abort: async () => { finish?.("Stopped"); }, dispose: () => {},
  }) };
  const engine = new Engine(f.store, fake), running = engine.run();
  try {
    await waitFor(() => prompts === 1);
    f.store.dm("user", "worker-0001", "Keep this instruction"); engine.wake("worker-0001");
    await waitFor(() => prompts === 2);
    assert.match(retried, /Keep this instruction/);
    assert.equal(f.store.worker("worker-0001").deliveredUserMessageId, undefined);
  } finally { await engine.pause(); await running; await f.cleanup(); }
});

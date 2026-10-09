import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import { Engine } from "../src/engine.js";
import { manifest } from "../src/artifacts.js";
import { workerNames } from "../src/models.js";
import type { AgentDriver, AgentOptions } from "../src/driver.js";

const inert: AgentDriver = { create: async () => ({ prompt: async () => "", steer: async () => false, abort: async () => {}, dispose: () => {} }) };
function review(f: Awaited<ReturnType<typeof fixture>>, actor: string) {
  f.store.evidence(actor, { generation: f.store.state.frozenGeneration!, requirement: "review", status: "verified", detail: "Inspected frozen snapshot" });
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Timed out");
}

test("names remain unique without prescribing work", () => {
  const names = workerNames(10000, () => 0);
  assert.equal(new Set(names).size, 10000);
  assert.ok(names.every(name => !/implement|review|integrat|research/i.test(name)));
});

test("snapshot content is stable, repeated publication is idempotent, and audit is generation-bound", async () => {
  const f = await fixture(2);
  try {
    const engine = new Engine(f.store, inert);
    await engine.publish("worker-0001", () => writeFile(join(f.store.state.integration, "report.txt"), "one"));
    const original = f.store.state.artifacts![0]!;
    await engine.publish("worker-0001", () => writeFile(join(f.store.state.integration, "report.txt"), "one"));
    assert.equal(f.store.state.artifactGeneration, 1);
    await engine.freeze("worker-0001");
    review(f, "worker-0001"); review(f, "worker-0002");
    f.store.tapOut("worker-0001", "complete", "Checked");
    const revision = f.store.state.revision;
    f.store.dm("worker-0002", "worker-0001", "status update");
    assert.equal(f.store.state.revision, revision);
    assert.ok(f.store.state.tapouts["worker-0001"]);
    await assert.rejects(engine.publish("worker-0001", () => writeFile(join(f.store.state.integration, "report.txt"), "bad")), /Frozen/);
    engine.thaw("worker-0002", "New material finding");
    await engine.publish("worker-0001", () => writeFile(join(f.store.state.integration, "report.txt"), "two"));
    assert.equal(f.store.state.artifactGeneration, 2);
    assert.equal(await readFile(join(original.snapshot, "report.txt"), "utf8"), "one");
    assert.deepEqual(f.store.state.tapouts, {});
    await engine.freeze("worker-0001");
    assert.throws(() => f.store.evidence("worker-0001", { generation: 1, requirement: "old", status: "verified", detail: "stale" }), /frozen generation/);
  } finally { await f.cleanup(); }
});

test("logical internal symlinks hash consistently across copied generations", async () => {
  const f = await fixture(1);
  try {
    await writeFile(join(f.store.state.integration, "source.txt"), "hello");
    await symlink(join(f.store.state.integration, "source.txt"), join(f.store.state.integration, "alias.txt"));
    const engine = new Engine(f.store, inert);
    const generation = await engine.freeze("worker-0001");
    assert.equal((await manifest(generation.snapshot)).digest, (await manifest(f.store.state.integration)).digest);
  } finally { await f.cleanup(); }
});

test("dependency gates, delayed contingencies and cancellation notify the actual owner", async () => {
  const f = await fixture(2);
  try {
    const primary = f.store.task("worker-0001", "create", { title: "Primary" });
    const secondary = f.store.task("worker-0001", "create", { title: "Dependent", blockedBy: [primary.id] });
    assert.throws(() => f.store.task("worker-0002", "claim", { id: secondary.id }), /dependencies/);
    f.store.task("worker-0001", "claim", { id: primary.id });
    f.store.task("worker-0001", "complete", { id: primary.id, result: "ready" });
    f.store.task("worker-0002", "claim", { id: secondary.id });
    f.store.task("worker-0001", "cancel", { id: secondary.id, result: "Superseded by primary", supersededBy: primary.id });
    assert.equal(f.store.state.tasks[1]!.status, "cancelled");
    assert.equal(f.store.state.dms.at(-1)!.to, "worker-0002");
    const delayed = f.store.task("worker-0001", "create", { title: "Backup", delayMs: 60000 });
    assert.throws(() => f.store.task("worker-0002", "claim", { id: delayed.id }), /not available/);
  } finally { await f.cleanup(); }
});

test("DM acknowledgement and reply state respects conversation ownership", async () => {
  const f = await fixture(3);
  try {
    assert.throws(() => f.store.dm("worker-0001", "worker-0001", "Self note"), /cannot send a DM to itself/);
    const message = f.store.dm("worker-0001", "worker-0002", "Question", { requiresAck: true, ackTimeoutMs: 1 });
    f.store.readDms("worker-0001");
    assert.equal(f.store.state.dms[0]!.status, "sent");
    assert.throws(() => f.store.acknowledgeDm("worker-0003", message.id), /addressed/);
    assert.equal(f.store.readDms("worker-0002")[0]!.status, "read");
    f.store.acknowledgeDm("worker-0002", message.id);
    f.store.dm("worker-0002", "worker-0001", "Answer", { replyTo: message.id });
    assert.equal(f.store.state.dms[0]!.status, "answered");
    assert.throws(() => f.store.dm("worker-0003", "worker-0001", "Invalid", { replyTo: message.id }), /conversation/);
  } finally { await f.cleanup(); }
});

test("inaccessible evidence remains visible; contradictory evidence blocks readiness", async () => {
  const f = await fixture(1);
  try {
    const engine = new Engine(f.store, inert);
    const generation = await engine.freeze("worker-0001");
    f.store.evidence("worker-0001", { generation: generation.number, requirement: "reference timing", status: "inaccessible", detail: "Timed attempts were blocked by the reference server" });
    assert.ok(f.store.readiness().ready);
    f.store.evidence("worker-0001", { generation: generation.number, requirement: "reference timing", status: "contradicted", detail: "Measured timing mismatches" });
    assert.equal(f.store.readiness().ready, false);
    f.store.tapOut("worker-0001", "complete", "Local work done; timing discrepancy recorded");
    assert.equal(f.store.state.status, "completed");
    assert.equal(f.store.state.outcome?.status, "partial");
    assert.ok(f.store.state.outcome?.reasons.some(reason => /contradicted/.test(reason)));
  } finally { await f.cleanup(); }
});

test("parked workers make no polling turns and wake for incoming DMs", { timeout: 5000 }, async () => {
  const f = await fixture(1); let calls = 0;
  let engine!: Engine;
  const driver: AgentDriver = { create: async () => ({ prompt: async () => { calls++; engine.park("worker-0001"); return "Waiting"; }, steer: async () => false, abort: async () => {}, dispose: () => {} }) };
  engine = new Engine(f.store, driver); const running = engine.run();
  try {
    await waitFor(() => calls === 1);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(calls, 1);
    f.store.dm("user", "worker-0001", "New instruction"); engine.wake("worker-0001");
    await waitFor(() => calls === 2);
  } finally { await engine.pause(); await running; await f.cleanup(); }
});

test("native frozen validation turns use the snapshot and read-only sandbox", { timeout: 5000 }, async () => {
  const f = await fixture(1); let calls = 0, validated = false; let engine!: Engine;
  const driver: AgentDriver = { create: async (options) => ({ prompt: async () => {
    calls++;
    if (calls === 1) { await engine.freeze(options.id); return "Frozen"; }
    assert.equal(options.currentReadOnly?.(), true);
    assert.equal(options.currentWorkspace?.(), f.store.state.artifacts![0]!.snapshot);
    validated = true; engine.park(options.id); return "Validated";
  }, steer: async () => false, abort: async () => {}, dispose: () => {} }) };
  engine = new Engine(f.store, driver); const running = engine.run();
  try { await waitFor(() => validated); }
  finally { await engine.pause(); await running; await f.cleanup(); }
});

test("runtime grace is bounded to one frozen attempt and token limits still win", { timeout: 5000 }, async () => {
  const f = await fixture(1); let finish: ((text: string) => void) | undefined;
  f.store.update(state => { state.config.maxRuntimeMs = 20; state.config.finalizationGraceMs = 300; });
  const engine = new Engine(f.store, { create: async () => ({ prompt: () => new Promise(resolve => { finish = resolve; }), steer: async () => false, abort: async () => { finish?.("stopped"); }, dispose: () => {} }) });
  await engine.freeze("worker-0001");
  try {
    await engine.run();
    assert.equal(f.store.state.graceDeadlineElapsedMs, 320);
    assert.ok(f.store.state.elapsedMs >= 320);
    assert.equal(f.store.state.status, "paused");
  } finally { await f.cleanup(); }
});

test("validation tasks can finish during freeze and another worker cannot erase objections", async () => {
  const f = await fixture(2);
  try {
    const task = f.store.task("worker-0001", "create", { title: "Validate", kind: "validation" });
    f.store.task("worker-0002", "claim", { id: task.id });
    const engine = new Engine(f.store, inert), artifact = await engine.freeze("worker-0001");
    assert.throws(() => f.store.task("worker-0002", "complete", { id: task.id, result: "checked", generation: artifact.number - 1 }), /frozen generation/);
    f.store.task("worker-0002", "complete", { id: task.id, result: "checked", generation: artifact.number });
    f.store.evidence("worker-0002", { generation: artifact.number, requirement: "visual", status: "contradicted", detail: "Material discrepancy" });
    f.store.evidence("worker-0001", { generation: artifact.number, requirement: "visual", status: "verified", detail: "I believe it passes" });
    assert.equal(f.store.readiness().ready, false);
    f.store.evidence("worker-0002", { generation: artifact.number, requirement: "visual", status: "verified", detail: "Verified after rechecking" });
    assert.equal(f.store.readiness().ready, true);
  } finally { await f.cleanup(); }
});

test("backup claims require a stalled primary rather than merely a quiet one", async () => {
  const f = await fixture(2);
  try {
    const backup = f.store.task("worker-0001", "create", { title: "Backup", contingencyFor: "worker-0001" });
    assert.throws(() => f.store.task("worker-0002", "claim", { id: backup.id }), /healthy/);
    f.store.update(state => { state.workers[0]!.stallSince = new Date().toISOString(); });
    f.store.task("worker-0002", "claim", { id: backup.id });
    assert.equal(f.store.state.tasks[0]!.owner, "worker-0002");
  } finally { await f.cleanup(); }
});

test("silent busy workers get a potential-stall flag and real activity clears it", { timeout: 5000 }, async () => {
  const f = await fixture(1); let finish: ((text: string) => void) | undefined;
  f.store.update(state => { state.config.stallTimeoutMs = 10; });
  const engine = new Engine(f.store, { create: async () => ({ prompt: () => new Promise(resolve => { finish = resolve; }), steer: async () => false, abort: async () => { finish?.("stop"); }, dispose: () => {} }) });
  const running = engine.run();
  try {
    await waitFor(() => !!f.store.worker("worker-0001").stallSince);
    engine.heartbeat("worker-0001", "native-tool");
    assert.equal(f.store.worker("worker-0001").stallSince, undefined);
  } finally { await engine.pause(); await running; await f.cleanup(); }
});

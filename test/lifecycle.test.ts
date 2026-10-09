import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { workerTools } from "../src/tools.js";

const inert = { create: async () => ({ prompt: async () => "", steer: async () => false, abort: async () => {}, dispose() {} }) };

test("one tap-out closes owned tasks without freeze or structured evidence", async () => {
  const f = await fixture(2);
  try {
    const task = f.store.task("worker-0001", "create", { title: "Validation", kind: "validation" });
    f.store.task("worker-0001", "claim", { id: task.id });
    f.store.tapOut("worker-0001", "complete", "Rendered and checked locally");
    assert.equal(f.store.state.tasks.find(t => t.id === task.id)!.status, "done");
    assert.notEqual(f.store.state.phase, "finalization");
    assert.equal(f.store.state.outcome, undefined);
    f.store.tapOut("worker-0002", "complete", "Reviewed output");
    assert.equal(f.store.state.outcome?.status, "complete");
    assert.equal(f.store.state.status, "completed");
    assert.equal(f.store.state.frozenGeneration, undefined);
  } finally { await f.cleanup(); }
});

test("blocked tap-out closes outstanding work and stops without a closeout ceremony", async () => {
  const f = await fixture(1);
  try {
    const task = f.store.task("worker-0001", "create", { title: "Reference comparison" });
    f.store.task("worker-0001", "claim", { id: task.id });
    f.store.tapOut("worker-0001", "blocked", "Reference inaccessible; local artifact works");
    assert.equal(f.store.state.tasks.find(t => t.id === task.id)!.status, "cancelled");
    assert.match(f.store.state.tasks.find(t => t.id === task.id)!.result!, /Reference inaccessible/);
    assert.equal(f.store.state.outcome?.status, "blocked");
    assert.equal(f.store.state.status, "completed");
  } finally { await f.cleanup(); }
});

test("README changes reuse renderer evidence and tap-out; changed renderer invalidates only its reviewer", async () => {
  const f = await fixture(3);
  try {
    const engine = new Engine(f.store, inert);
    await writeFile(join(f.store.state.integration, "app.js"), "one");
    await writeFile(join(f.store.state.integration, "README.md"), "one");
    const first = await engine.freeze("worker-0003");
    f.store.evidence("worker-0001", { generation: first.number, requirement: "runtime", status: "verified", detail: "Browser validation", files: { "app.js": first.files["app.js"]! } });
    f.store.evidence("worker-0002", { generation: first.number, requirement: "claims", status: "verified", detail: "README validation", files: { "README.md": first.files["README.md"]! } });
    f.store.tapOut("worker-0001", "complete", "Runtime checked");
    f.store.tapOut("worker-0002", "complete", "Claims checked");
    engine.thaw("worker-0003", "Correct README");
    await engine.publish("worker-0003", () => writeFile(join(f.store.state.integration, "README.md"), "two"));
    const second = await engine.freeze("worker-0003");
    assert.equal(f.store.worker("worker-0001").status, "tapped_out");
    assert.equal(f.store.worker("worker-0002").status, "idle");
    const carried = f.store.state.evidence!.find(e => e.actor === "worker-0001" && e.generation === second.number)!;
    assert.equal(carried.reusedFrom, first.number);
    engine.thaw("worker-0003", "Change renderer");
    await engine.publish("worker-0003", () => writeFile(join(f.store.state.integration, "app.js"), "two"));
    await engine.freeze("worker-0003");
    assert.equal(f.store.worker("worker-0001").status, "idle");
    assert.equal(f.store.state.tapouts["worker-0001"], undefined);
  } finally { await f.cleanup(); }
});

test("snapshot deltas are paginated, persisted, private and unaffected by heartbeat/clock churn", async () => {
  const f = await fixture(3);
  try {
    for (let i = 0; i < 5; i++) f.store.post("worker-0002", `board-${i}`);
    f.store.dm("worker-0002", "worker-0003", "private-dm-content");
    f.store.dm("worker-0002", "worker-0001", "for me");
    const task = f.store.task("worker-0001", "create", { title: "Work" });
    const first = f.store.coordinationSnapshot("worker-0001", 2);
    assert.equal(first.board.length, 2); assert.equal(first.more.board, true);
    assert.doesNotMatch(JSON.stringify(first), /private-dm-content|secret/);
    assert.equal(first.dms[0]?.text, "for me");
    const reopened = Store.open(f.directory);
    assert.deepEqual(reopened.coordinationSnapshot("worker-0001", 2).board.map(p => p.text), ["board-2", "board-3"]);
    reopened.coordinationSnapshot("worker-0001", 2);
    const revision = reopened.state.coordinationRevision;
    reopened.heartbeat("worker-0001", "turn-complete");
    reopened.update(s => { s.elapsedMs++; });
    const quiet = reopened.coordinationSnapshot("worker-0001");
    assert.equal(quiet.status, undefined); assert.deepEqual(quiet.tasks, []); assert.deepEqual(quiet.board, []); assert.deepEqual(quiet.dms, []);
    assert.equal(quiet.revision, revision);
    reopened.task("worker-0001", "claim", { id: task.id });
    assert.equal(reopened.coordinationSnapshot("worker-0001").tasks.length, 1);
  } finally { await f.cleanup(); }
});

test("routine board posts and teammate DMs cannot reactivate tapped-out workers", async () => {
  const f = await fixture(2);
  try {
    const engine = new Engine(f.store, inert), artifact = await engine.freeze("worker-0001");
    f.store.evidence("worker-0001", { generation: artifact.number, requirement: "review", status: "verified", detail: "Checked" });
    f.store.tapOut("worker-0001", "complete", "Done");
    f.store.post("worker-0002", "Routine update"); engine.notify("board", "worker-0002");
    f.store.dm("worker-0002", "worker-0001", "FYI"); engine.wake("worker-0001");
    assert.equal(f.store.worker("worker-0001").status, "tapped_out");
    f.store.dm("user", "worker-0001", "New requested check"); engine.wake("worker-0001", true);
    assert.equal(f.store.worker("worker-0001").status, "idle");
  } finally { await f.cleanup(); }
});

test("whole-artifact evidence notices additions, and resolved objections remain resolved on reuse", async () => {
  const f = await fixture(2);
  try {
    const engine = new Engine(f.store, inert);
    await writeFile(join(f.store.state.integration, "app.js"), "one");
    const first = await engine.freeze("worker-0002");
    f.store.evidence("worker-0001", { generation: first.number, requirement: "runtime", status: "contradicted", detail: "Earlier defect", files: { "app.js": first.files["app.js"]! } });
    f.store.evidence("worker-0001", { generation: first.number, requirement: "runtime", status: "verified", detail: "Rechecked and resolved", files: { "app.js": first.files["app.js"]! } });
    f.store.evidence("worker-0002", { generation: first.number, requirement: "whole artifact", status: "verified", detail: "Reviewed all files" });
    f.store.tapOut("worker-0001", "complete", "Resolved");
    engine.thaw("worker-0002", "Add documentation");
    await engine.publish("worker-0002", () => writeFile(join(f.store.state.integration, "README.md"), "new"));
    const second = await engine.freeze("worker-0002");
    const carried = f.store.state.evidence!.filter(e => e.generation === second.number);
    assert.equal(carried.length, 1); assert.equal(carried[0]!.status, "verified");
    assert.equal(f.store.worker("worker-0001").status, "tapped_out");
    f.store.post("user", "A new requirement changes the review scope");
    await engine.freeze("worker-0002");
    f.store.tapOut("worker-0001", "partial", "New scope remains unverified");
    assert.equal(f.store.worker("worker-0001").status, "tapped_out");
  } finally { await f.cleanup(); }
});


test("automatic task closure wakes its subscribed reviewer", async () => {
  const f = await fixture(2);
  try {
    f.store.update(state => { state.status = "running"; });
    const engine = new Engine(f.store, inert);
    const task = f.store.task("worker-0001", "create", { title: "Renderer" });
    f.store.task("worker-0001", "claim", { id: task.id });
    engine.park("worker-0002", { tasks: [task.id] });
    assert.equal(f.store.worker("worker-0002").parked, true);
    const tool = workerTools(engine, "worker-0001").find(t => t.name === "tap_out")!;
    await tool.execute("finish", { outcome: "complete", reason: "Renderer delivered and tested" });
    assert.equal(f.store.worker("worker-0002").parked, false);
    assert.equal(f.store.worker("worker-0001").status, "tapped_out");
  } finally { await f.cleanup(); }
});

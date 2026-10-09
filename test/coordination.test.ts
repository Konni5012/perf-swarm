import test from "node:test";
import assert from "node:assert/strict";
import { assignModels, parseMix, workerIds } from "../src/models.js";
import { Store } from "../src/store.js";
import { fixture } from "./helpers.js";

function review(store: Store, actor: string) {
  if (store.state.frozenGeneration === undefined) store.freeze();
  store.evidence(actor, { generation: store.state.frozenGeneration!, requirement: "independent review", detail: "Checked frozen fixture", status: "verified" });
}
test("weighted models have exact rounded counts and shuffled assignments", () => {
  const mix = parseMix("sol=1/3,luna=2/3");
  const assigned = assignModels(4, mix, "fallback", () => 0);
  assert.equal(assigned.filter((model) => model === "sol").length, 1);
  assert.equal(assigned.filter((model) => model === "luna").length, 3);
  assert.notDeepEqual(assigned, ["sol", "luna", "luna", "luna"]);
  assert.equal(assignModels(7, mix, "fallback").length, 7);
  assert.throws(() => parseMix("sol=0,luna=1"));
  assert.throws(() => parseMix("sol=1/0"));
  assert.throws(() => parseMix("sol=1,sol=2"));
  assert.throws(() => assignModels(10001, mix, "fallback"));
});
test("four-digit worker IDs remain unique for the entire namespace", () => {
  const ids = workerIds(10000);
  assert.equal(new Set(ids).size, 10000);
  assert.ok(ids.every((id) => /^worker-\d{4}$/.test(id)));
});
test("all workers tap out; mixed findings finish partial without a reset cycle", async () => {
  const f = await fixture(3);
  try {
    for (const w of f.store.state.workers) review(f.store, w.id);
    f.store.tapOut("worker-0001", "complete", "Checked");
    f.store.tapOut("worker-0002", "partial", "Remaining discrepancy");
    assert.equal(f.store.state.status, "ready");
    f.store.tapOut("worker-0003", "partial", "Same discrepancy");
    assert.equal(f.store.state.status, "completed");
    assert.equal(f.store.state.outcome?.status, "partial");
    assert.equal(Object.keys(f.store.state.tapouts).length, 3);
    assert.throws(() => f.store.tapOut("worker-0001", "complete", "Again"), /Already tapped out/);
  } finally { await f.cleanup(); }
});
test("agreed inaccessible requirement finishes blocked and preserves evidence", async () => {
  const f = await fixture(3);
  try {
    f.store.freeze();
    for (const w of f.store.state.workers) {
      f.store.evidence(w.id, { generation: 0, requirement: "essential reference", status: "inaccessible", detail: "HTTP 403 challenge on two shared attempts", files: {} });
      f.store.tapOut(w.id, "blocked", "Reference inaccessible");
    }
    assert.equal(f.store.state.outcome?.status, "blocked");
    assert.equal(f.store.state.evidence?.length, 3);
    assert.equal(f.store.state.frozenGeneration, 0);
  } finally { await f.cleanup(); }
});
test("task ownership is exclusive and only owners can complete or release", async () => {
  const f = await fixture();
  try {
    const task = f.store.task("worker-0001", "create", { title: "Research" });
    f.store.task("worker-0002", "claim", { id: task.id });
    assert.throws(() => f.store.task("worker-0003", "claim", { id: task.id }));
    assert.throws(() => f.store.task("worker-0001", "complete", { id: task.id, result: "Finished" }));
    f.store.task("worker-0002", "complete", { id: task.id, result: "Evidence" });
    assert.equal(f.store.state.tasks[0]!.status, "done");
  } finally { await f.cleanup(); }
});
test("four active children per worker, parent-specific slots and no tap-out with active helpers", async () => {
  const f = await fixture();
  try {
    const children = Array.from({ length: 4 }, (_, i) => f.store.reserveChild("worker-0001", `task ${i}`));
    assert.throws(() => f.store.reserveChild("worker-0001", "fifth"), /four active/);
    assert.throws(() => f.store.reserveChild(children[0]!, "grandchild"), /Unknown worker/);
    assert.throws(() => f.store.tapOut("worker-0001", "complete", "Done"), /helper/);
    f.store.reserveChild("worker-0002", "independent");
    f.store.update((state) => { state.children[0]!.status = "completed"; });
    f.store.reserveChild("worker-0001", "replacement");
  } finally { await f.cleanup(); }
});
test("persistence retains coordination, while each public view hides models, sessions and other DMs", async () => {
  const f = await fixture();
  try {
    f.store.post("worker-0001", "Shared finding");
    f.store.dm("worker-0001", "worker-0002", "Private finding");
    f.store.dm("user", "worker-0003", "User instruction");
    f.store.reserveChild("worker-0001", "Helper task");
    const reopened = Store.open(f.directory);
    assert.equal(reopened.state.children.length, 1);
    assert.equal(reopened.state.dms.length, 2);
    const first = JSON.stringify(reopened.publicView("worker-0001"));
    assert.match(first, /Private finding/);
    assert.doesNotMatch(first, /User instruction|assigned-secret|helper-secret|threadId|accountedTokens/);
    const third = JSON.stringify(reopened.publicView("worker-0003"));
    assert.doesNotMatch(third, /Private finding/);
    assert.match(third, /User instruction/);
  } finally { await f.cleanup(); }
});

test("message pulls respect N, cursors, conversation filters and DM privacy", async () => {
  const f = await fixture(3);
  try {
    for (let i = 0; i < 7; i++) f.store.post("worker-0001", `post-${i}`);
    assert.deepEqual(f.store.readBoard(2).map(post => post.text), ["post-5", "post-6"]);
    const cursor = f.store.state.board[4]!.id;
    assert.deepEqual(f.store.readBoard(10, cursor).map(post => post.text), ["post-5", "post-6"]);
    f.store.dm("worker-0001", "worker-0002", "sent");
    const incoming = f.store.dm("worker-0002", "worker-0001", "received");
    f.store.dm("worker-0003", "worker-0002", "private-dm-content");
    f.store.dm("user", "worker-0001", "instruction");
    assert.deepEqual(f.store.readDms("worker-0001", 10).map(dm => dm.text), ["sent", "received", "instruction"]);
    assert.deepEqual(f.store.readDms("worker-0001", 10, undefined, "worker-0002").map(dm => dm.text), ["sent", "received"]);
    assert.deepEqual(f.store.readDms("worker-0001", 10, incoming.id).map(dm => dm.text), ["instruction"]);
    const status = f.store.coordinationView("worker-0001");
    assert.equal(status.boardMessages, 7); assert.equal(status.dmMessages, 3);
    assert.doesNotMatch(JSON.stringify(status), /post-6|private-dm-content|received|instruction|assigned-secret/);
    for (const limit of [0, -1, 1.5, 1001]) assert.throws(() => f.store.readBoard(limit), /limit/);
    assert.throws(() => f.store.readDms("worker-0001", 10, -1), /cursor/);
  } finally { await f.cleanup(); }
});

test("worker aliases are persistent, resolve in coordination, and do not assign roles", async () => {
  const f = await fixture(2);
  try {
    f.store.update(state => { state.workers[0]!.name = "Mica-1"; state.workers[1]!.name = "Nori-2"; });
    f.store.dm("Mica-1", "Nori-2", "hello");
    const message = f.store.readDms("Nori-2")[0]!;
    assert.equal(message.status, "read");
    f.store.acknowledgeDm("Nori-2", message.id);
    assert.equal(f.store.state.dms[0]!.status, "acknowledged");
    assert.equal(f.store.coordinationView("Mica-1").workers[0]!.name, "Mica-1");
  } finally { await f.cleanup(); }
});

test("optional frozen evidence remains associated with tap-outs", async () => {
  const f = await fixture(1);
  try {
    const task = f.store.task("worker-0001", "create", { title: "Evidence" });
    f.store.task("worker-0001", "claim", { id: task.id });
    f.store.task("worker-0001", "complete", { id: task.id, result: "checked" });
    f.store.update(state => { state.artifactGeneration = 3; });
    f.store.freeze();
    f.store.evidence("worker-0001", { generation: 3, requirement: "Evidence", status: "verified", detail: "checked" });
    f.store.tapOut("worker-0001", "complete", "generation 3 checked");
    assert.equal(f.store.state.outcome?.status, "complete");
    assert.equal(f.store.state.frozenGeneration, 3);
    assert.ok(f.store.state.freezeAt);
  } finally { await f.cleanup(); }
});

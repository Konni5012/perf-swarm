import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ExperimentStore } from "../src/experiments.js";
import { fixture } from "./helpers.js";

test("experiment ledger preserves failed and successful attempts with snapshots and immutable completion", async () => {
  const { directory, store, cleanup } = await fixture(1);
  try {
    const workspace = store.state.workers[0]!.workspace;
    await writeFile(join(workspace, "trial.txt"), "first\n");
    const ledger = new ExperimentStore(directory);
    const failed = await ledger.create({ actor: "worker-0001", objective: store.state.objective, hypothesis: "Try the first strategy", workspace });
    await ledger.checkpoint(failed.id, "worker-0001", "The first check is slower than baseline", { latency_ms: 120 });
    const finished = await ledger.finish(failed.id, "worker-0001", { status: "failed", result: "Timeout under load", failureCategory: "timeout" });
    assert.equal(finished.status, "failed");
    assert.equal(await readFile(join(finished.snapshot!, "trial.txt"), "utf8"), "first\n");
    await assert.rejects(() => ledger.finish(failed.id, "worker-0001", { status: "succeeded", result: "retry" }), /already failed/);

    await writeFile(join(workspace, "trial.txt"), "second\n");
    const succeeded = await ledger.create({ actor: "worker-0001", objective: store.state.objective, hypothesis: "Retry with a bounded queue", workspace, parent: failed.id });
    await ledger.finish(succeeded.id, "worker-0001", { status: "succeeded", result: "All checks passed", metrics: { throughput: 42 } });
    const records = await ledger.list({ actor: "worker-0001" });
    assert.deepEqual(records.map(record => record.status).sort(), ["failed", "succeeded"]);
    assert.equal((await ledger.get(succeeded.id)).parent, failed.id);
  } finally { await cleanup(); }
});

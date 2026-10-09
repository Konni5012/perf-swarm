import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunConfig, RunState } from "../src/types.js";
import { Store } from "../src/store.js";

export function config(workers = 4): RunConfig {
  return { workers, model: "main-secret", mix: [], subagentModel: "helper-secret", thinking: "high" };
}
export async function fixture(workers = 4) {
  const directory = await mkdtemp(join(tmpdir(), "swarm-test-"));
  const state: RunState = {
    version: 4, id: "test-run", objective: "Produce report.txt containing hello", source: join(directory, "source"), createdAt: new Date().toISOString(), status: "ready", config: config(workers),
    workers: Array.from({ length: workers }, (_, i) => ({ id: `worker-${String(i + 1).padStart(4, "0")}`, model: `assigned-secret-${i}`, workspace: join(directory, `worker-${i}`), status: "idle", restarts: 0 })),
    integration: join(directory, "integration"), git: false, children: [], board: [], dms: [], tasks: [], tapouts: {}, revision: 0, tokens: 0, elapsedMs: 0, sequence: 0,
  };
  for (const path of [state.source, state.integration, ...state.workers.map((worker) => worker.workspace)]) await mkdir(path);
  const store = new Store(directory, state);
  store.save();
  return { directory, store, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

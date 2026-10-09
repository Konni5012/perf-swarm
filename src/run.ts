import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { RunConfig, RunState } from "./types.js";
import { assignModels, workerIds, workerNames } from "./models.js";
import { Store } from "./store.js";
import { prepareWorkspaces } from "./workspaces.js";

export async function createRun(objective: string, source: string, stateDirectory: string, config: RunConfig): Promise<Store> {
  if (!objective.trim()) throw new Error("An objective is required.");
  source = resolve(source);
  if (source === resolve(stateDirectory)) throw new Error("Choose a state directory distinct from the input workspace (for example .perf-swarm).");
  if (!(await stat(source)).isDirectory()) throw new Error("The workspace must be an input directory or repository root.");
  const id = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const directory = join(resolve(stateDirectory), id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const models = assignModels(config.workers, config.mix, config.model);
  const names = workerNames(config.workers);
  config = { ...config, stallTimeoutMs: config.stallTimeoutMs ?? 90_000, finalizationGraceMs: config.finalizationGraceMs ?? 120_000 };
  const workers = workerIds(config.workers).map((id, index) => ({ id, name: names[index], model: models[index]!, workspace: join(directory, "workspaces", id), status: "idle" as const, restarts: 0 }));
  const state: RunState = {
    version: 4, id, objective, source, createdAt: new Date().toISOString(), status: "ready", config, capabilities: config.capabilities, phase: "implementation", artifacts: [], evidence: [],
    workers, children: [], board: [], dms: [], tasks: [], tapouts: {}, revision: 0, integrator: workers[0]!.id,
    integration: join(directory, "integration"), git: false, elapsedMs: 0, tokens: 0, sequence: 0, artifactGeneration: 0,
  };
  await prepareWorkspaces(state, directory);
  const store = new Store(directory, state);
  store.save();
  store.post("user", objective);
  store.event("created", `Created ${config.workers} workers with isolated ${state.git ? "Git worktrees" : "workspaces"}; manager: ${state.integrator}`, "system");
  return store;
}

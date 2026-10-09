import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, realpath, stat, readdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RunState } from "./types.js";

const execute = promisify(execFile);
export async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execute("git", args, { cwd, signal, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}
export function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export async function copyWorkspace(source: string, destination: string, excluded: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  source = await realpath(source);
  destination = await realpath(destination);
  excluded = await realpath(excluded).catch(() => resolve(excluded));
  const excludeState = !inside(excluded, source);
  const visit = async (from: string, to: string): Promise<void> => {
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const path = join(from, entry.name);
      const target = join(to, entry.name);
      // Walk directories ourselves: fs.cp rejects nested destinations before applying its filter.
      if ((excludeState && inside(excluded, path)) || inside(destination, path) || [".git", ".perf-swarm", ".pi", ".codex", "node_modules"].includes(relative(source, path).split(sep)[0]!)) continue;
      if (entry.isDirectory()) { await mkdir(target, { recursive: true }); await visit(path, target); }
      else if (entry.isSymbolicLink()) {
        const original = await realpath(path).catch(() => undefined);
        if (!original || !inside(source, original)) continue;
        // Relocate internal links so editing the copy cannot modify the original input through a link.
        await symlink(relative(dirname(target), resolve(destination, relative(source, original))), target);
      } else if (entry.isFile()) await cp(path, target);
    }
  };
  await visit(source, destination);
}
export async function prepareWorkspaces(state: RunState, directory: string): Promise<void> {
  const created: string[] = [];
  try {
    const top = await git(state.source, ["rev-parse", "--show-toplevel"]);
    if (await realpath(top) !== await realpath(state.source)) throw new Error("Directory inputs inside a repository use copied workspaces.");
    state.baseCommit = await git(state.source, ["rev-parse", "--verify", "HEAD"]);
    state.git = true;
  } catch { state.git = false; }
  await mkdir(join(directory, "workspaces"), { recursive: true });
  try {
    for (const worker of state.workers) {
      if (state.git) {
        worker.branch = `swarm/${state.id}/${worker.id}`;
        await git(state.source, ["worktree", "add", "-b", worker.branch, worker.workspace, state.baseCommit!]);
        created.push(worker.workspace);
      } else await copyWorkspace(state.source, worker.workspace, dirname(directory));
    }
    if (state.git) {
      await git(state.source, ["worktree", "add", "-b", `swarm/${state.id}/integration`, state.integration, state.baseCommit!]);
      created.push(state.integration);
    } else await copyWorkspace(state.source, state.integration, dirname(directory));
  } catch (error) {
    // Remove only worktrees this setup just created. Never remove pre-existing user worktrees.
    for (const path of created.reverse()) await git(state.source, ["worktree", "remove", path]).catch(() => {});
    throw error;
  }
}

export async function publishArtifact(state: RunState, id: string, path: string, destination: string): Promise<string> {
  const worker = state.workers.find((worker) => worker.id === id);
  if (!worker) throw new Error(`Unknown worker: ${id}`);
  const source = resolve(worker.workspace, path);
  const target = resolve(state.integration, destination);
  if (!inside(worker.workspace, source) || !inside(state.integration, target) || target === state.integration) throw new Error("Artifact paths must stay inside the worker and integration workspaces.");
  if ([path, destination].some((part) => part.split(/[\\/]/).some((segment) => [".git", ".perf-swarm", ".pi", ".codex"].includes(segment)))) throw new Error("Internal state cannot be published as an artifact.");
  const sourceReal = await realpath(source);
  if (!inside(await realpath(worker.workspace), sourceReal) || !(await stat(source)).isFile()) throw new Error("Publish regular files within the worker workspace only.");
  // Refuse symlinked destination ancestors that would escape integration.
  let ancestor = target;
  while (true) {
    try { if (!inside(await realpath(state.integration), await realpath(ancestor))) throw new Error("Artifact destination escapes integration."); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) throw new Error("Invalid artifact destination.");
    ancestor = parent;
  }
  await mkdir(resolve(target, ".."), { recursive: true });
  await cp(sourceReal, target);
  return target;
}

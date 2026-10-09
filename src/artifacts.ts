import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, mkdir, chmod, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { inside, copyWorkspace } from "./workspaces.js";
import type { ArtifactGeneration } from "./types.js";

export async function manifest(root: string): Promise<{ digest: string; files: Record<string, string> }> {
  const files: Record<string, string> = {};
  async function visit(path: string, prefix: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", ".perf-swarm", ".pi", ".codex", "node_modules"].includes(entry.name)) continue;
      const key = prefix + entry.name, target = join(path, entry.name);
      if (entry.isDirectory()) await visit(target, key + "/");
      else if (entry.isSymbolicLink()) { const actual = await realpath(target).catch(() => undefined); if (actual && inside(root, actual)) files[key] = createHash("sha256").update("link:" + relative(root, actual)).digest("hex"); }
      else if (entry.isFile()) {
        const mode = (await lstat(target)).mode & 0o111;
        files[key] = createHash("sha256").update(String(mode)).update(await readFile(target)).digest("hex");
      }
    }
  }
  await visit(root, "");
  return { files, digest: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}

export async function snapshot(integration: string, run: string, number: number, author: string): Promise<ArtifactGeneration> {
  const path = join(run, "generations", `${number}-${randomUUID()}`);
  await mkdir(join(run, "generations"), { recursive: true });
  await mkdir(path, { recursive: false });
  await copyWorkspace(integration, path, run);
  const result = await manifest(path);
  // Snapshots are outside every worker's writable root. Remove file write bits as well.
  for (const file of Object.keys(result.files)) {
    const target = join(path, file), stat = await lstat(target);
    if (stat.isFile()) await chmod(target, stat.mode & ~0o222);
  }
  return { number, author, snapshot: path, createdAt: new Date().toISOString(), ...result };
}

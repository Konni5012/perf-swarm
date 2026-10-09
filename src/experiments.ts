import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExperimentRecord, ExperimentStatus } from "./types.js";
import { copyWorkspace, git } from "./workspaces.js";

const execute = promisify(execFile);

/** Durable, append-only attempt ledger. Each attempt keeps its evidence beside its metadata. */
export class ExperimentStore {
  readonly root: string;
  constructor(readonly runDirectory: string) { this.root = join(runDirectory, "experiments"); }

  private async directory(id: string) { const path = join(this.root, id); await mkdir(path, { recursive: true, mode: 0o700 }); return path; }
  private async record(id: string): Promise<ExperimentRecord> { return JSON.parse(await readFile(join(this.root, id, "metadata.json"), "utf8")) as ExperimentRecord; }
  private async save(record: ExperimentRecord): Promise<void> {
    const path = await this.directory(record.id);
    await writeFile(join(path, "metadata.json"), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  }
  private async event(id: string, type: string, data: Record<string, unknown> = {}) {
    await appendFile(join(await this.directory(id), "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), type, ...data }) + "\n", { mode: 0o600 });
  }

  async create(input: { actor: string; objective: string; hypothesis: string; workspace: string; parent?: string; tags?: string[] }): Promise<ExperimentRecord> {
    if (!input.hypothesis.trim()) throw new Error("An experiment hypothesis is required.");
    const id = `exp-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
    const record: ExperimentRecord = { id, actor: input.actor, objective: input.objective, hypothesis: input.hypothesis, status: "running", createdAt: new Date().toISOString(), parent: input.parent, workspace: input.workspace, tags: input.tags };
    try { record.baseCommit = await git(input.workspace, ["rev-parse", "HEAD"]); } catch { /* directory inputs need no commit */ }
    await this.save(record); await this.event(id, "created", { actor: input.actor, hypothesis: input.hypothesis });
    return record;
  }

  async checkpoint(id: string, actor: string, note: string, metrics?: Record<string, number | string | boolean>): Promise<void> {
    const record = await this.record(id);
    if (record.status !== "running") throw new Error(`Experiment ${id} is already ${record.status}.`);
    await this.event(id, "checkpoint", { actor, note, metrics });
    if (metrics) { record.metrics = { ...(record.metrics ?? {}), ...metrics }; await this.save(record); }
  }

  async finish(id: string, actor: string, input: { status: ExperimentStatus; result: string; failureCategory?: string; metrics?: Record<string, number | string | boolean>; tags?: string[] }): Promise<ExperimentRecord> {
    if (input.status === "running") throw new Error("A finished experiment needs a terminal status.");
    if (!input.result.trim()) throw new Error("A result or failure explanation is required.");
    const record = await this.record(id);
    if (record.status !== "running") throw new Error(`Experiment ${id} is already ${record.status}; create a new attempt instead of overwriting it.`);
    const path = await this.directory(id);
    const snapshot = join(path, "workspace");
    await copyWorkspace(record.workspace, snapshot, this.runDirectory);
    record.snapshot = snapshot; record.completedAt = new Date().toISOString(); record.status = input.status; record.result = input.result;
    record.failureCategory = input.failureCategory; record.metrics = { ...(record.metrics ?? {}), ...(input.metrics ?? {}) }; record.tags = [...new Set([...(record.tags ?? []), ...(input.tags ?? [])])];
    try { record.diff = await execute("git", ["-C", record.workspace, "diff", "--binary", record.baseCommit ?? "HEAD"], { maxBuffer: 16 * 1024 * 1024 }).then(r => r.stdout); } catch { record.diff = ""; }
    await writeFile(join(path, "diff.patch"), record.diff ?? "", { mode: 0o600 });
    await this.save(record); await this.event(id, "finished", { actor, status: input.status, result: input.result, failureCategory: input.failureCategory, metrics: input.metrics });
    return record;
  }

  async list(filter?: { status?: ExperimentStatus; actor?: string; query?: string }): Promise<ExperimentRecord[]> {
    let entries: string[] = []; try { entries = (await readdir(this.root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }
    const records = await Promise.all(entries.map(id => this.record(id).catch(() => undefined)));
    return records.filter((record): record is ExperimentRecord => {
      if (!record) return false;
      if (filter?.status && record.status !== filter.status) return false;
      if (filter?.actor && record.actor !== filter.actor) return false;
      return !filter?.query || `${record.id} ${record.hypothesis} ${record.result ?? ""} ${record.failureCategory ?? ""}`.toLowerCase().includes(filter.query.toLowerCase());
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<ExperimentRecord> { return this.record(id); }
}

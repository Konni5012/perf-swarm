import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent, RunState, TelemetryEvent, Post, DirectMessage, ArtifactGeneration, Evidence } from "./types.js";

export class Store extends EventEmitter {
  readonly stateFile: string;
  constructor(readonly directory: string, public state: RunState) {
    super();
    this.stateFile = join(directory, "state.json");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  static open(directory: string): Store {
    const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as RunState;
    if (state.version !== 4 || !Array.isArray(state.workers) || !state.config) throw new Error("Unsupported or invalid swarm state. This lifecycle requires schema 4; start a fresh run.");
    return new Store(directory, state);
  }
  save(): void {
    const temporary = `${this.stateFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, this.stateFile);
  }
  update(fn: (state: RunState) => void): void {
    // Transactions do not await: task claims, tap-outs, and child reservations are atomic in this process.
    const next = structuredClone(this.state);
    fn(next);
    const coordination = (s: RunState) => JSON.stringify([s.objective, s.status, s.tasks, s.board, s.dms.map(({ status, readAt, acknowledgedAt, ...dm }) => dm), s.children.map(({id, parent, task, status, result}) => ({id, parent, task, status, result})), s.integrator, s.artifactGeneration, s.frozenGeneration, s.capabilities, s.browserAccess, s.evidence, s.tapouts, s.outcome]);
    next.coordinationRevision = (this.state.coordinationRevision ?? 0) + (coordination(next) === coordination(this.state) ? 0 : 1);
    next.sequence++;
    const previous = this.state;
    this.state = next;
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    this.emit("change");
  }
  event(type: string, message: string, actor?: string): void {
    const event: RunEvent = { at: new Date().toISOString(), type, actor, message };
    appendFileSync(join(this.directory, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
    this.emit("event", event);
  }
  telemetry(event: TelemetryEvent): void {
    appendFileSync(join(this.directory, "telemetry.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
  }
  worker(id: string) {
    const worker = this.state.workers.find((worker) => worker.id === id || worker.name === id);
    if (!worker) throw new Error(`Unknown worker: ${id}`);
    return worker;
  }
  heartbeat(id: string, activity = "turn"): void {
    const now = new Date().toISOString();
    if (!this.state.workers.some(worker => worker.id === id || worker.name === id)) return;
    const previous = this.state.workers.find(item => item.id === id || item.name === id)?.lastHeartbeatAt;
    if (previous && Date.now() - Date.parse(previous) < 1000 && !this.worker(id).stallSince && activity !== "turn-complete") return;
    this.update((state) => {
      const worker = state.workers.find((item) => item.id === id || item.name === id);
      if (!worker) return;
      worker.lastHeartbeatAt = now;
      worker.lastActivityAt = now;
      worker.stallSince = undefined;
      if (activity.includes("turn")) worker.lastTurnAt = now;
      if (activity.includes("tool")) worker.lastToolAt = now;
    });
    if (activity === "turn-start" || activity === "turn-complete") this.event("heartbeat", activity, id);
  }
  private resetTapouts(state: RunState): void {
    state.tapouts = {};
    state.outcome = undefined;
    for (const e of state.evidence ?? []) e.obsolete = true;
    for (const worker of state.workers) if (worker.status === "tapped_out") worker.status = "idle";
    state.revision++;
    state.phase = "implementation"; state.frozenGeneration = undefined; state.freezeAt = undefined;
  }
  invalidate(reason = "Material change"): void { this.update((state) => { state.frozenGeneration = undefined; state.freezeAt = undefined; state.phase = "implementation"; state.revision++; }); this.event("invalidation", reason, "system"); }
  artifact(artifact: ArtifactGeneration): void {
    this.update(state => { (state.artifacts ??= []).push(artifact); state.artifactGeneration = artifact.number; state.revision++; state.frozenGeneration = undefined; state.freezeAt = undefined; state.phase = "implementation";
      const latest = new Map<string, Evidence>(); for (const e of state.evidence ?? []) if (!e.obsolete && e.generation === artifact.number - 1) latest.set(e.actor + ":" + e.requirement, e);
      const prior = [...latest.values()];
      for (const e of prior) {
        const reusable = e.scope === "artifact" ? state.artifacts?.find(a => a.number === e.generation)?.digest === artifact.digest : e.files && Object.entries(e.files).every(([path, hash]) => artifact.files[path] === hash);
        if (reusable) { (state.evidence ??= []).push({ ...e, id: Math.max(state.sequence, ...(state.evidence ?? []).map(e => e.id)) + 1, generation: artifact.number, reusedFrom: e.reusedFrom ?? e.generation }); if (state.tapouts[e.actor]) { state.tapouts[e.actor]!.generation = artifact.number; state.tapouts[e.actor]!.digest = artifact.digest; } }
        else if (state.tapouts[e.actor]) { delete state.tapouts[e.actor]; const w = state.workers.find(w => w.id === e.actor)!; w.status = "idle"; w.parked = false; }
      }
    });
    this.event("artifact", `Generation ${artifact.number}: ${artifact.digest}`, artifact.author);
  }
  freeze(): void {
    if (this.state.tasks.some(task => !["done", "cancelled"].includes(task.status) && task.kind !== "validation")) throw new Error("Close all implementation tasks before freezing.");
    if (this.state.children.some(child => ["pending", "running", "cancelling"].includes(child.status))) throw new Error("Finish or cancel all helpers before freezing.");
    this.update(state => { state.frozenGeneration = state.artifactGeneration ?? 0; state.freezeAt = new Date().toISOString(); state.phase = "validation"; });
    this.event("freeze", `Generation ${this.state.frozenGeneration} frozen for validation`, "system");
  }
  evidence(actor: string, input: Omit<Evidence, "id" | "actor">): Evidence {
    actor = this.worker(actor).id;
    if (!input.requirement.trim() || !input.detail.trim()) throw new Error("Evidence requires a requirement and concrete detail.");
    if (input.generation !== this.state.frozenGeneration) throw new Error("Evidence must inspect the frozen generation.");
    let item!: Evidence;
    this.update(state => {
      const frozen = state.artifacts?.find(a => a.number === input.generation);
      if (input.files && Object.entries(input.files).some(([path, hash]) => frozen?.files[path] !== hash)) throw new Error("Evidence dependencies must match frozen file hashes.");
      item = { ...input, scope: input.files ? "files" : "artifact", files: input.files ?? frozen?.files, actor, id: Math.max(state.sequence, ...(state.evidence ?? []).map(e => e.id)) + 1 }; (state.evidence ??= []).push(item); state.evidenceRevision = (state.evidenceRevision ?? 0) + 1;
      if (["unverified", "contradicted"].includes(input.status)) state.phase = "validation";
    });
    this.event("evidence", `${input.status}: ${input.requirement} (generation ${input.generation})`, actor);
    return item;
  }
  readiness() {
    const generation = this.state.frozenGeneration;
    const evidence = (this.state.evidence ?? []).filter(item => !item.obsolete && item.generation === generation);
    const latest = new Map<string, Evidence>(); for (const item of evidence) latest.set(item.actor + ":" + item.requirement, item);
    const gaps = [
      ...this.state.tasks.filter(task => !["done", "cancelled"].includes(task.status)).map(task => `Task ${task.id} remains ${task.status}`),
      ...this.state.workers.filter(worker => worker.status === "failed" || worker.stallSince).map(worker => `Worker ${worker.name ?? worker.id} is unavailable`),
      ...this.state.children.filter(child => ["pending", "running", "cancelling"].includes(child.status)).map(child => `Active subagent ${child.id}`),
      ...[...latest.values()].filter(item => ["unverified", "contradicted"].includes(item.status)).map(item => `${item.requirement}: ${item.status}`),
    ];
    return { ready: !gaps.length, gaps, generation, digest: this.state.artifacts?.find(item => item.number === generation)?.digest };
  }
  post(author: string, text: string): Post {
    if (!text.trim()) throw new Error("Message cannot be empty.");
    this.update((state) => {
      if (author === "user") this.resetTapouts(state);
      state.coordinationRevision = (state.coordinationRevision ?? 0) + 1;
      state.board.push({ id: state.sequence + 1, author, text, at: new Date().toISOString() });
    });
    this.event("board", text, author);
    return this.state.board.at(-1)!;
  }
  dm(author: string, to: string, text: string, options: { requiresAck?: boolean; ackTimeoutMs?: number; replyTo?: number } = {}): DirectMessage {
    if (to !== "user") to = this.worker(to).id;
    if (!["user", "system"].includes(author)) author = this.worker(author).id;
    if (author === to) throw new Error("A worker cannot send a DM to itself.");
    if (!text.trim()) throw new Error("Message cannot be empty.");
    this.update((state) => {
      if (author === "user" && to !== "user") { delete state.tapouts[to]; const w = state.workers.find(w => w.id === to)!; w.status = "idle"; w.parked = false; for (const e of state.evidence ?? []) if (e.actor === to) e.obsolete = true; }
      state.coordinationRevision = (state.coordinationRevision ?? 0) + 1;
      if (options.replyTo !== undefined) {
        const original = state.dms.find(dm => dm.id === options.replyTo && dm.to === author && dm.author === to);
        if (!original) throw new Error("Reply must reference a message in this conversation.");
        original.status = "answered";
      }
      state.dms.push({ id: state.sequence + 1, author, to, text, at: new Date().toISOString(), status: "sent", requiresAck: options.requiresAck, replyTo: options.replyTo,
        ackDeadline: options.requiresAck ? new Date(Date.now() + (options.ackTimeoutMs ?? 60_000)).toISOString() : undefined });
    });
    this.event("dm", `→ ${to}: ${text}`, author);
    return this.state.dms.at(-1)!;
  }
  task(actor: string, action: "create" | "claim" | "complete" | "release" | "cancel", input: { id?: number; title?: string; description?: string; result?: string; kind?: "implementation" | "validation"; generation?: number; contingencyFor?: string; blockedBy?: number[]; supersededBy?: number; delayMs?: number }) {
    actor = this.worker(actor).id;
    let id = input.id;
    this.update((state) => {
      const existing = state.tasks.find(task => task.id === id);
      if (state.frozenGeneration !== undefined && ((action === "create" ? input.kind : existing?.kind) !== "validation")) throw new Error("Tasks are frozen; explicitly thaw before changing work.");
      if (action === "create") {
        if (!input.title?.trim()) throw new Error("A task needs a title.");
        id = state.sequence + 1;
        for (const dependency of input.blockedBy ?? []) if (!state.tasks.some(task => task.id === dependency)) throw new Error(`Unknown dependency ${dependency}`);
        state.tasks.push({ id, title: input.title, description: input.description ?? "", status: "open", kind: input.kind ?? "implementation", contingencyFor: input.contingencyFor ? this.worker(input.contingencyFor).id : undefined, blockedBy: input.blockedBy,
          availableAt: input.delayMs ? new Date(Date.now() + input.delayMs).toISOString() : undefined });
      } else {
        const task = state.tasks.find((task) => task.id === id);
        if (!task) throw new Error(`Unknown task: ${id}`);
        if (action === "cancel") {
          if (["done", "cancelled"].includes(task.status)) throw new Error("Task is already closed.");
          if (!input.result?.trim()) throw new Error("Cancellation needs a reason.");
          if (input.supersededBy !== undefined && !state.tasks.some(item => item.id === input.supersededBy && item.id !== task.id)) throw new Error("Invalid superseding task.");
          const owner = task.owner;
          task.status = "cancelled"; task.result = input.result; task.supersededBy = input.supersededBy;
          if (owner) state.dms.push({ id: state.sequence + 1, author: "system", to: owner, text: `Task ${task.id} cancelled: ${input.result}`, at: new Date().toISOString(), status: "sent" });
        } else if (action === "claim") {
          if (task.contingencyFor) { const primary = state.workers.find(worker => worker.id === task.contingencyFor)!; if (!primary.stallSince && primary.status !== "failed") throw new Error("Primary worker is healthy; contingency remains unavailable."); }
          if (task.availableAt && Date.now() < Date.parse(task.availableAt)) throw new Error("Contingency task is not available yet.");
          if ((task.blockedBy ?? []).some(id => !state.tasks.some(item => item.id === id && ["done", "cancelled"].includes(item.status)))) throw new Error("Task dependencies are incomplete.");
          if (task.status !== "open") throw new Error(`Task ${id} is already owned or finished.`);
          task.owner = actor; task.status = "claimed";
        } else {
          if (task.owner !== actor || task.status !== "claimed") throw new Error("Only the current task owner can complete or release it.");
          if (action === "complete") {
            if (task.kind === "validation" && (state.frozenGeneration === undefined || input.generation !== state.frozenGeneration)) throw new Error("Validation task completion must reference the frozen generation.");
            if (!input.result?.trim()) throw new Error("Completing a task requires its result/evidence.");
            task.status = "done"; task.result = input.result;
          } else { task.owner = undefined; task.status = "open"; }
        }
      }
      state.coordinationRevision = (state.coordinationRevision ?? 0) + 1;

    });
    this.event("task", `${action} task ${id}`, actor);
    return this.state.tasks.find((task) => task.id === id)!;
  }
  electIntegrator(actor: string): void {
    this.worker(actor);
    this.update((state) => {
      if (state.integrator && state.integrator !== actor) {
        const current = state.workers.find(worker => worker.id === state.integrator);
        if (current && current.status !== "failed" && !current.stallSince) throw new Error(`${state.integrator} already owns integration; coordinate with them by DM.`);
      }
      state.integrator = actor;
    });
    this.event("integrator", "Manager owns integration", actor);
  }
  tapOut(actor: string, outcome: "complete" | "blocked" | "partial", reason: string): void {
    actor = this.worker(actor).id;
    if (!reason.trim()) throw new Error("Tap-out requires concrete findings or blockers.");
    const gaps = this.state.children.filter(c => c.parent === actor && ["pending", "running", "cancelling"].includes(c.status)).map(c => `Finish helper ${c.id}`);
    if (this.state.tapouts[actor]) gaps.push("Already tapped out");
    if (gaps.length) throw new Error(`Cannot tap out: ${gaps.join("; ")}`);
    this.update(state => {
      // A contribution report closes its task records without a second model turn.
      for (const task of state.tasks) if (task.owner === actor && !["done", "cancelled"].includes(task.status)) {
        task.status = outcome === "complete" ? "done" : "cancelled";
        task.result = reason;
      }
      state.tapouts[actor] = { outcome, reason, generation: state.frozenGeneration ?? state.artifactGeneration ?? 0, digest: state.artifacts?.find(a => a.number === state.frozenGeneration)?.digest };
      const worker = state.workers.find(w => w.id === actor)!;
      worker.status = "tapped_out"; worker.parked = true; worker.subscription = { generation: true, tasks: state.tasks.filter(t => t.owner === actor).map(t => t.id) };
      state.coordinationRevision = (state.coordinationRevision ?? 0) + 1;
      if (Object.keys(state.tapouts).length === state.workers.length) {
        const reports = Object.values(state.tapouts);
        const readiness = this.readiness();
        const latest = new Map<string, Evidence>(); for (const e of state.evidence ?? []) if (!e.obsolete && e.generation === state.frozenGeneration) latest.set(e.actor + ":" + e.requirement, e);
        const inaccessible = [...latest.values()].some(e => ["inaccessible", "partially_verified"].includes(e.status));
        const status = reports.some(t => t.outcome === "blocked") ? "blocked" : reports.every(t => t.outcome === "complete") && readiness.ready && !inaccessible ? "complete" : "partial";
        state.outcome = { status, reasons: [...new Set([...reports.map(t => t.reason), ...readiness.gaps, ...[...latest.values()].filter(e => e.status !== "verified").map(e => `${e.requirement}: ${e.status} — ${e.detail}`)])] };
        state.status = "completed"; state.phase = "finalization";
      }
    });
    this.event("tap-out", `${outcome}: ${reason}`, actor);
    if (this.state.outcome) this.event("outcome", JSON.stringify(this.state.outcome), "system");
  }
  reactivate(actor: string): void {
    if (!this.state.tapouts[actor]) return;
    this.update(state => { delete state.tapouts[actor]; const w = state.workers.find(w => w.id === actor)!; w.status = "idle"; w.parked = false; state.outcome = undefined; });
  }
  reserveChild(parent: string, task: string): string {
    this.worker(parent);
    if (!task.trim()) throw new Error("Subagent task cannot be empty.");
    let id = "";
    this.update((state) => {
      if (state.frozenGeneration !== undefined) throw new Error("Cannot spawn a subagent while frozen.");
      if (state.children.filter((child) => child.parent === parent && ["pending", "running", "cancelling"].includes(child.status)).length >= 4) throw new Error("Limit reached: four active subagents per worker.");
      id = `${parent}/sub-${state.sequence + 1}`;
      state.children.push({ id, parent, task, status: "pending" });
      state.revision++;
    });
    return id;
  }
  private recent<T extends Post>(messages: T[], limit: number, after?: number): T[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Message limit must be an integer from 1 to 1000.");
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new Error("Message cursor must be a nonnegative integer.");
    return messages.filter(message => after === undefined || message.id > after).slice(-limit);
  }
  readBoard(limit = 20, after?: number): Post[] { return this.recent(this.state.board, limit, after); }
  readDms(actor: string, limit = 20, after?: number, peer?: string): DirectMessage[] {
    actor = this.worker(actor).id;
    if (peer && !["user", "system"].includes(peer)) peer = this.worker(peer).id;
    const messages = this.recent(this.state.dms.filter(dm => (dm.to === actor || dm.author === actor) && (!peer || (dm.author === actor ? dm.to : dm.author) === peer)), limit, after);
    const unread = messages.filter(dm => dm.to === actor && ["sent", "delivered"].includes(dm.status ?? "sent"));
    if (unread.length) this.update(state => { const now = new Date().toISOString(); for (const dm of state.dms) if (unread.some(item => item.id === dm.id)) { dm.status = "read"; dm.readAt = now; } });
    return messages.map(message => this.state.dms.find(item => item.id === message.id)!);
  }
  acknowledgeDm(actor: string, id: number): DirectMessage {
    actor = this.worker(actor).id;
    if (!this.state.dms.some(item => item.id === id && item.to === actor)) throw new Error("No direct message with that ID is addressed to this worker.");
    this.update(state => { const item = state.dms.find(message => message.id === id)!; item.status = "acknowledged"; item.acknowledgedAt = new Date().toISOString(); });
    return this.state.dms.find(item => item.id === id)!;
  }
  coordinationSnapshot(actor: string, limit = 12, reset = false) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Snapshot limit must be an integer from 1 to 100.");
    actor = this.worker(actor).id;
    const worker = this.worker(actor), cursor = reset ? undefined : worker.snapshotCursor;
    const board = this.state.board.filter(p => p.id > (cursor?.board ?? 0)).slice(0, limit);
    const dms = this.state.dms.filter(d => (d.to === actor || d.author === actor) && d.id > (cursor?.dm ?? 0)).slice(0, limit);
    const tasks = this.state.tasks.filter(t => JSON.stringify(t) !== cursor?.tasks[t.id]);
    const status = { objective: this.state.objective, integration: this.state.integration, integrator: this.state.integrator, workers: this.state.workers.map(w => ({ id: w.id, name: w.name })), generation: this.state.frozenGeneration, artifactGeneration: this.state.artifactGeneration, capabilities: this.state.capabilities, reviewedOutput: this.state.artifacts?.find(a => a.number === this.state.frozenGeneration)?.snapshot, accessBlockers: this.state.browserAccess, tapouts: this.state.tapouts, outcome: this.state.outcome, evidence: (this.state.evidence ?? []).filter(e => !e.obsolete && e.generation === this.state.frozenGeneration), helpers: this.state.children.filter(c => c.parent === actor).map(({ id, task, status, result }) => ({ id, task, status, result })) };
    const signature = JSON.stringify(status);
    this.update(state => {
      const w = state.workers.find(w => w.id === actor)!;
      w.snapshotCursor = { board: board.at(-1)?.id ?? cursor?.board ?? 0, dm: dms.at(-1)?.id ?? cursor?.dm ?? 0, status: signature, tasks: Object.fromEntries(state.tasks.map(t => [t.id, JSON.stringify(t)])) };
      for (const dm of state.dms) if (dm.to === actor && dms.some(d => d.id === dm.id) && ["sent", "delivered"].includes(dm.status ?? "sent")) { dm.status = "read"; dm.readAt = new Date().toISOString(); }
    });
    return { revision: this.state.coordinationRevision ?? 0, status: signature === cursor?.status ? undefined : status, tasks, board, dms, more: { board: this.state.board.some(p => p.id > this.worker(actor).snapshotCursor!.board), dms: this.state.dms.some(d => (d.to === actor || d.author === actor) && d.id > this.worker(actor).snapshotCursor!.dm) } };
  }
  coordinationView(actor: string) {
    const { board, dms, ...status } = this.publicView(actor);
    return { ...status, boardMessages: this.state.board.length, dmMessages: this.state.dms.filter(dm => dm.to === actor || dm.author === actor).length,
      readiness: this.readiness(),
      unreadDms: this.state.dms.filter(dm => dm.to === actor && ["sent", "delivered"].includes(dm.status ?? "sent")).length,
      overdueAcks: this.state.dms.filter(dm => dm.author === actor && dm.requiresAck && dm.ackDeadline && Date.now() > Date.parse(dm.ackDeadline) && !["acknowledged", "answered"].includes(dm.status ?? "sent")).map(dm => dm.id),
      helpers: this.state.children.filter(child => child.parent === actor).map(({ id, task, status, result }) => ({ id, task, status, result })) };
  }
  publicView(actor?: string) {
    return {
      objective: this.state.objective,
      status: this.state.status,
      workers: this.state.workers.map(({ id, name, status, lastHeartbeatAt, lastActivityAt, stallSince }) => ({ id, name, status, lastHeartbeatAt, lastActivityAt, stallSince })),
      integration: this.state.integration,
      reviewedOutput: this.state.artifacts?.find(item => item.number === this.state.frozenGeneration)?.snapshot,
      integrator: this.state.integrator,
      board: this.state.board.slice(-80),
      tasks: this.state.tasks,
      tapouts: this.state.tapouts,
      outcome: this.state.outcome,
      artifactGeneration: this.state.artifactGeneration ?? 0,
      frozenGeneration: this.state.frozenGeneration, phase: this.state.phase ?? "implementation",
      capabilities: this.state.capabilities, artifacts: this.state.artifacts, evidence: this.state.evidence,
      dms: actor ? this.state.dms.filter((dm) => dm.to === actor || dm.author === actor).slice(-80) : [],
    };
  }
}

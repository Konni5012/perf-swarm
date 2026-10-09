import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDriver, AgentHandle, AgentOptions } from "./driver.js";
import type { Subscription } from "./types.js";
import { Store } from "./store.js";
import { workerTools } from "./tools.js";
import { manifest, snapshot } from "./artifacts.js";
import { BrowserProvider } from "./browser.js";

export class Engine {
  private handles = new Map<string, AgentHandle>();
  private operations = new Set<Promise<void>>();
  private busy = new Set<string>();
  private wakeups = new Set<string>();
  private nextTurn = new Map<string, number>();
  private steering = new Set<string>();
  private inFlightUserMessages = new Map<string, Set<number>>();
  private stopping?: Promise<void>;
  private lastClock = 0;
  private started = false;
  private artifactQueue: Promise<unknown> = Promise.resolve();
  private fileScanAt = 0;
  private fileScanning = false;
  private workspaceDigests = new Map<string, string>();
  readonly browser: BrowserProvider;

  constructor(readonly store: Store, readonly driver: AgentDriver) { this.browser = new BrowserProvider({ backend: store.state.config.browserBackend, profileDirectory: join(store.directory, "browser", "profiles") }, store.state.browserAccess, failure => {
    this.store.update(state => { state.browserAccess = [...(state.browserAccess ?? []).filter(f => f.origin !== failure.origin), ...(failure.attempts ? [failure] : [])]; });
    if (failure.attempts === 2) this.store.post("system", `Shared reference-access blocker: ${failure.url} (${failure.kind}). Two identical attempts; stop retries until access changes. ${failure.detail}`);
  }); }
  assertRunning(): void { if (this.store.state.status !== "running") throw new Error("The swarm is paused or finished."); }
  wake(actor: string, relevant = false): void {
    if (actor === "user") return;
    const id = this.store.worker(actor).id;
    if (this.store.state.tapouts[id] && !relevant) return;
    if (relevant) this.store.reactivate(id);
    this.wakeups.add(id);
    if (this.store.worker(id).parked) this.store.update(state => { const w = state.workers.find(w => w.id === id)!; w.parked = false; w.waitReason = undefined; });
  }
  wakeAll(except?: string): void { for (const worker of this.store.state.workers) if (worker.id !== except) this.wake(worker.id); }
  notify(event: "board" | "task" | "generation" | "dm", actor?: string, taskId?: number): void {
    for (const w of this.store.state.workers) {
      if (w.id === actor) continue;
      const sub = w.subscription;
      if (event === "board" && sub?.board && !this.store.state.tapouts[w.id]) this.wake(w.id);
      if (event === "task") {
        const task = this.store.state.tasks.find(t => t.id === taskId);
        const relevant = task?.owner === w.id || (sub?.tasks?.includes(taskId!) ?? false) || this.store.state.tasks.some(t => t.owner === w.id && t.blockedBy?.includes(taskId!));
        if (relevant) this.wake(w.id, true);
        else if (task?.status === "open" && w.parked && sub?.tasks === undefined) this.wake(w.id);
      }
      if (event === "generation" && !this.store.state.tapouts[w.id] && (sub?.generation || this.store.state.tasks.some(t => t.owner === w.id && t.kind === "validation" && t.status === "claimed") || !(this.store.state.evidence ?? []).some(e => !e.obsolete && e.actor === w.id && e.generation === this.store.state.artifactGeneration))) this.wake(w.id);
    }
  }
  heartbeat(actor: string, activity = "turn"): void { this.store.heartbeat(actor, activity); }
  private safeReason(reason: string): string {
    let safe = reason;
    const models = new Set([this.store.state.config.model, this.store.state.config.subagentModel, ...this.store.state.workers.map((worker) => worker.model)]);
    for (const model of [...models].sort((a, b) => b.length - a.length)) if (model) {
      safe = safe.replaceAll(model, "[model]");
      const bare = model.replace(/^openai-codex\//, "");
      if (bare) safe = safe.replaceAll(bare, "[model]");
    }
    return safe;
  }
  private usage = (tokens: number): void => {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.store.update((state) => { state.tokens += tokens; });
    this.checkBudget();
  };
  private async serializedArtifact<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.artifactQueue.then(operation); this.artifactQueue = next.catch(() => {}); return next;
  }
  async publish(actor: string, operation: () => Promise<unknown>): Promise<unknown> {
    return this.serializedArtifact(async () => {
      if (this.store.state.frozenGeneration !== undefined) throw new Error("Frozen generation: thaw explicitly before publishing.");
      const result = await operation(); await this.captureArtifact(actor); return { result, generation: this.store.state.artifactGeneration };
    });
  }
  private async captureArtifact(actor: string) {
    const live = await manifest(this.store.state.integration);
    const latest = this.store.state.artifacts?.at(-1);
    if (latest?.digest === live.digest) return latest;
    const number = (latest?.number ?? 0) + 1;
    const item = await snapshot(this.store.state.integration, this.store.directory, number, actor);
    const after = await manifest(this.store.state.integration);
    if (live.digest !== after.digest || live.digest !== item.digest) {
      await rm(item.snapshot, { recursive: true, force: true }); throw new Error("Integration changed while snapshotting; retry after writers finish.");
    }
    this.store.artifact(item); this.notify("generation", actor); return item;
  }
  async freeze(actor: string) {
    return this.serializedArtifact(async () => {
      if (this.store.state.tasks.some(task => !["done", "cancelled"].includes(task.status) && task.kind !== "validation")) throw new Error("Close all implementation tasks before freezing.");
      if (this.store.state.children.some(child => ["pending", "running", "cancelling"].includes(child.status))) throw new Error("Finish all helpers before freezing.");
      const item = await this.captureArtifact(actor); this.store.freeze();
      for (const w of this.store.state.workers) if (!this.store.state.tapouts[w.id] && (w.id === actor || !(this.store.state.evidence ?? []).some(e => !e.obsolete && e.actor === w.id && e.generation === item.number) || this.store.state.tasks.some(t => t.owner === w.id && t.kind === "validation" && t.status === "claimed"))) this.wake(w.id);
      return item;
    });
  }
  thaw(actor: string, reason: string) {
    if (!reason.trim()) throw new Error("Thaw requires a material-change reason.");
    this.store.invalidate(`${actor} thawed: ${reason}`); this.wake(actor, true); if (this.store.state.integrator) this.wake(this.store.state.integrator, true);
  }
  private checkBudget(): void {
    if (this.store.state.status !== "running") return;
    const state = this.store.state;
    if (state.config.maxTokens !== undefined && state.tokens >= state.config.maxTokens) void this.pause("Token budget reached. Increase --max-tokens when resuming.");
    else {
      const phase = state.phase ?? "implementation";
      const limit = state.config.phaseBudgets?.[phase];
      if (limit !== undefined && (state.phaseElapsedMs?.[phase] ?? 0) >= limit) { void this.pause(`${phase} phase budget reached.`); return; }
      if (state.config.maxRuntimeMs !== undefined && state.elapsedMs >= state.config.maxRuntimeMs) {
        if (state.frozenGeneration !== undefined && state.phase !== "implementation" && state.graceDeadlineElapsedMs === undefined) {
          const grace = state.config.finalizationGraceMs ?? 120_000;
          this.store.update(next => { next.graceDeadlineElapsedMs = state.config.maxRuntimeMs! + grace; });
          this.store.event("budget", `Finalization grace: ${grace}ms, bounded to this frozen attempt.`, "system");
        }
        if (this.store.state.graceDeadlineElapsedMs === undefined || state.phase === "implementation" || state.elapsedMs >= this.store.state.graceDeadlineElapsedMs) void this.pause("Runtime budget reached. Increase --max-runtime when resuming.");
      }
    }
  }
  park(id: string, subscription: Subscription = { dms: true }): void {
    this.store.update(state => { const worker = state.workers.find(worker => worker.id === id)!; worker.parked = true; worker.waitReason = "subscribed to relevant changes"; worker.subscription = subscription; });
  }
  private async scanFiles(): Promise<void> {
    if (this.fileScanning) return; this.fileScanning = true;
    try {
      for (const worker of this.store.state.workers) {
        if (!this.busy.has(worker.id)) continue;
        const digest = (await manifest(worker.workspace)).digest;
        const old = this.workspaceDigests.get(worker.id); this.workspaceDigests.set(worker.id, digest);
        if (old && old !== digest) {
          this.heartbeat(worker.id, "file-change");
          this.store.update(state => { state.workers.find(item => item.id === worker.id)!.lastFileChangeAt = new Date().toISOString(); });
        }
      }
    } catch (error) { this.store.event("liveness", `File scan unavailable: ${String(error)}`, "system"); }
    finally { this.fileScanning = false; }
  }
  private checkLiveness(): void {
    const now = Date.now();
    for (const worker of this.store.state.workers) {
      if (!this.busy.has(worker.id) || worker.waiting || !worker.lastHeartbeatAt) continue;
      const age = now - Date.parse(worker.lastHeartbeatAt);
      if (age > (this.store.state.config.stallTimeoutMs ?? 90_000) && !worker.stallSince) {
        const at = new Date().toISOString();
        this.store.update(state => { const current = state.workers.find(item => item.id === worker.id)!; current.stallSince = at; });
        this.store.event("stall", `No heartbeat for ${Math.round(age / 1000)}s; preserving the active turn and waiting for recovery.`, worker.id);
        for (const task of this.store.state.tasks) if (task.contingencyFor === worker.id && task.status === "open") this.notify("task", worker.id, task.id);
      }
    }
  }
  private async open(options: Omit<AgentOptions, "onUsage">): Promise<AgentHandle> {
    this.assertRunning();
    const handle = await this.driver.create({ ...options, onUsage: this.usage,
      onTelemetry: (event) => { this.store.telemetry(event); this.heartbeat(options.id, event.kind === "item-start" ? "native-tool" : event.kind); },
      onReview: (status, reason) => this.store.event("approval", `Codex native review: ${status} — ${this.safeReason(reason)}`, options.id),
    });
    if (this.store.state.status !== "running") { handle.dispose(); throw new Error("Run stopped during agent startup."); }
    this.handles.set(options.id, handle);
    return handle;
  }
  private close(id: string): void { this.handles.get(id)?.dispose(); this.handles.delete(id); }
  private launch(operation: Promise<void>): void {
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => {});
  }

  private workerSystem(id: string): string {
    const worker = this.store.worker(id);
    const name = worker.name ? ` Your persistent display name is ${worker.name}; it is an identity only, not a preassigned role.` : "";
    return `You are ${id}, an autonomous worker in perf-SWARM.${name} Your identity is your worker ID. Work areas are chosen by the workers, not assigned by names. Model assignments are intentionally undisclosed; do not seek them.
All workers receive the same objective and organize themselves. Work in meaningful bursts; do not end a turn merely to poll for another context snapshot. Start with coordination_snapshot instead of separately polling status, board, and DMs. No leader assigns tasks. Check coordination at natural checkpoints, discuss plans, atomically claim tasks, avoid duplicated work, and use DMs to coordinate. When blocked on teammates or helpers, use swarm_wait to subscribe to relevant task completion or a new generation, then end this turn. If you have no concrete implementation, validation, integration, evidence, or communication action, call swarm_sleep and end the turn. Respond to user instructions on the board and in your inbox. Your final plain-text reply is visible to the user, but teammates see only board posts and DMs.
Board: task ownership, handoffs, validation findings, blockers, decisions, and anything that changes swarm state. Post these updates on the shared board so every worker has the context. Use the experiment ledger for every meaningful engineering attempt: create a hypothesis before trying it, checkpoint observations and metrics, and finish it with a concrete succeeded/failed/blocked/inconclusive result. Search prior attempts before repeating a strategy; terminal attempts are immutable, so link retries with parent.
DM: detailed discussion, questions, private feedback, and short coordination that has no lasting impact. When a DM produces a material decision, finding, handoff, or blocker, summarize it concisely on the board. Do not leave essential coordination only in DMs; board posts complement task updates and checkpoint evidence.
Work only in your own workspace. Read applicable AGENTS.md instructions before changing project files. Other workers have separate worktrees/workspaces. Git tasks start from the committed source snapshot. Commit your work with git using a local command identity if needed (git -c user.name=SWARM -c user.email=swarm@localhost commit ...). Never push or publish without explicit user authorization.
Choose an integrator yourselves. Use integrator claim. The integrate workspace tool switches your native working directory to integration on your NEXT turn; end your current turn after switching. There you use native shell/edit tools to merge committed branches, verify outputs and resolve conflicts. integrate merge prepares an exact Git merge command for that next turn; it does not execute it. integrate publish copies a scoped non-Git artifact. Use integrate workspace with target worker to return to your own workspace. Deliverables must reach integration for teammate validation. Tell the integrator which branch/files are ready.
You may spawn up to four concurrent subagents with the subagent tool. Their model is selected by the user, not by you. They share your workspace, cannot delegate or access the board/DMs, and report only to you. Give bounded tasks and coordinate file edits. Collect or cancel helpers before tapping out.
Codex runs native tools in a workspace sandbox and uses native automatic review for approval requests. Respect denials and do not bypass sandbox boundaries. Never launch extra workers or helper agents through shell commands; use only the SWARM subagent tool. ${this.store.state.config.webSearch === false ? "Web search/browser tools are disabled. Do not use network research or launch web tools through shell commands." : "Built-in web search is available."}
Finish useful implementation and local validation, then call tap_out once with complete, blocked, or partial and concrete findings. Tap-out automatically closes your owned tasks; finish or cancel active helpers first. Freezing and structured evidence are optional tools for reviews that benefit from immutable snapshots, not completion prerequisites. Do not create another generation or edit files merely to clear a readiness flag. Unresolved evidence is included in the final outcome, never a reason for repeated closeout turns. If using frozen evidence, declare all file dependencies; unchanged hashes carry findings forward. There is no independent auditor or majority vote. After tap_out end the turn: routine messages do not reactivate you. All workers tapped out ends the run immediately. Essential inaccessible requirements mean blocked, not complete. After two identical reference-access failures share one blocker and park that effort until access changes; do not keep trying proxy variants. For acknowledgements use DM requiresAck and ack; replyTo records the answer.
${this.store.state.config.computerUseManifest ? (this.store.state.capabilities?.browser === "ready" ? "The installed Codex app and a host browser provider are available. Follow tool documentation and app permission prompts; use a separate browser session named for your worker and never control another worker’s tabs. Desktop apps are shared: coordinate exclusive access on the board. Report unavailable surfaces honestly; mocked Canvas output is not a browser screenshot." : "Computer Use MCP is connected, but no host browser provider is available in this run. Do not attempt to launch or control Safari, Helium, or another native browser. Use web search or existing reference artifacts, record browser access as inaccessible evidence, and continue with implementation." ) : "Native Computer Use is disconnected. Use only the SWARM browser tool: it lazily starts an isolated browser with a persistent profile and owned tabs per worker. The chrome backend runs inside a private virtual desktop; electron uses offscreen windows. Input targets your owned browser surface, never the physical mouse or desktop. Use snapshot elements or screenshots to choose selectors/coordinates; type, press, scroll, click_at and owned-tab tools are available. It never attaches to personal browser sessions. Do not launch, inspect, or control the user’s browser or desktop apps through shell commands or other tools."}
Original user objective:
${this.store.state.objective}`;
  }
  private userMessages(id: string) {
    const state = this.store.state;
    const first = state.board[0];
    const cursor = this.store.worker(id).deliveredUserMessageId ?? 0;
    const inFlight = this.inFlightUserMessages.get(id);
    return [...state.board.filter(post => post.author === "user" && !(post === first && post.text === state.objective)),
      ...state.dms.filter(dm => dm.author === "user" && dm.to === id)]
      .filter(message => message.id > cursor && !inFlight?.has(message.id)).sort((a, b) => a.id - b.id);
  }
  private trackUserMessages(id: string, messages: { id: number }[]): () => void {
    const pending = this.inFlightUserMessages.get(id) ?? new Set<number>();
    this.inFlightUserMessages.set(id, pending);
    for (const message of messages) pending.add(message.id);
    return () => { for (const message of messages) pending.delete(message.id); };
  }
  private deliveredUserMessages(id: string, messages: { id: number }[]): void {
    if (!messages.length) return;
    const last = messages.at(-1)!.id;
    this.store.update(state => {
      const worker = state.workers.find(worker => worker.id === id)!;
      worker.deliveredUserMessageId = Math.max(worker.deliveredUserMessageId ?? 0, last);
      for (const dm of state.dms) if (dm.to === id && messages.some(message => message.id === dm.id) && dm.status === "sent") dm.status = "delivered";
    });
  }
  private async steerUser(id: string, handle: AgentHandle): Promise<void> {
    const messages = this.userMessages(id);
    if (!messages.length || this.steering.has(id)) return;
    this.steering.add(id);
    const release = this.trackUserMessages(id, messages);
    try {
      if (await handle.steer(`New operator instructions:\n${JSON.stringify(messages)}`)) this.deliveredUserMessages(id, messages);
    } catch (error) { this.store.event("steering", this.safeReason(String(error)), id); }
    finally { release(); this.steering.delete(id); }
  }
  private async work(id: string): Promise<void> {
    this.busy.add(id);
    this.wakeups.delete(id);
    let handle = this.handles.get(id);
    try {
      const worker = this.store.worker(id);
      this.heartbeat(id, "turn-start");
      if (!this.workspaceDigests.has(id)) this.workspaceDigests.set(id, (await manifest(worker.workspace)).digest);
      if (!handle) {
        handle = await this.open({
          id, model: worker.model, workspace: worker.workspace, system: this.workerSystem(id),
          computerUse: Boolean(this.store.state.config.computerUseManifest),
          threadId: worker.threadId, accountedTokens: worker.accountedTokens,
          currentWorkspace: () => this.store.state.artifacts?.find(item => item.number === this.store.state.frozenGeneration)?.snapshot ?? (this.store.worker(id).integrationMode && this.store.state.integrator === id ? this.store.state.integration : worker.workspace),
          currentReadOnly: () => this.store.state.frozenGeneration !== undefined,
          onTotalUsage: (tokens) => this.store.update((state) => { state.workers.find((worker) => worker.id === id)!.accountedTokens = tokens; }),
          onApprovalRequired: (reason) => { void this.pause(reason); },
          onSession: (path) => this.store.update((state) => { state.workers.find((worker) => worker.id === id)!.threadId = path; }),
          tools: workerTools(this, id),
        });
      }
      this.assertRunning();
      this.store.update((state) => { state.workers.find((worker) => worker.id === id)!.status = "running"; });

      this.store.event("worker", "Working", id);
      const unread = this.store.state.dms.filter(dm => dm.to === id && !["read", "acknowledged", "answered"].includes(dm.status ?? "sent"));
      if (unread.length) this.store.update(state => { for (const dm of state.dms) if (unread.some(message => message.id === dm.id) && dm.status === "sent") dm.status = "delivered"; });
      const messages = this.userMessages(id);
      const release = this.trackUserMessages(id, messages);
      let output: string;
      try {
        output = await handle.prompt(`Continue your work on the original objective. Pull coordination updates as needed.${unread.length ? ` You have ${unread.length} unread DMs; pull them at a checkpoint.` : ""}${messages.length ? `\nNew operator instructions:\n${JSON.stringify(messages)}` : ""}`);
        this.deliveredUserMessages(id, messages);
      } finally { release(); }
      if (this.store.state.status === "running") {
        if (this.store.state.frozenGeneration === undefined && this.store.state.integrator === id) await this.serializedArtifact(() => this.captureArtifact(id));
        this.store.update((state) => {
          const current = state.workers.find((worker) => worker.id === id)!;
          current.status = state.tapouts[id] ? "tapped_out" : "idle";
          current.restarts = 0;
          current.lastError = undefined;
        });
        if (output.trim()) this.store.event("output", output.slice(0, 12_000), id);
        this.heartbeat(id, "turn-complete");
        if (!this.store.state.tapouts[id] && !this.store.worker(id).parked && !this.wakeups.has(id)) {
          const active = this.store.state.tasks.some(t => t.owner === id && t.status === "claimed");
          if (active) this.wake(id); else this.park(id);
        }
      }
    } catch (error) {
      this.close(id);
      if (this.store.state.status !== "running") return;
      const reason = this.safeReason(error instanceof Error ? error.message : String(error));
      this.store.update((state) => {
        delete state.tapouts[id];
        const worker = state.workers.find((worker) => worker.id === id)!;
        worker.restarts++; worker.lastError = reason;
        worker.status = worker.restarts > 3 ? "failed" : "idle";
      });
      const restarts = this.store.worker(id).restarts;
      this.store.event("recovery", `${reason} (${restarts > 3 ? "recovery exhausted" : `restart ${restarts}/3`})`, id);
      if (restarts > 3) void this.pause(`${id} could not recover after 3 restarts.`);
    } finally {
      this.busy.delete(id);
      this.nextTurn.set(id, Date.now() + (this.store.worker(id).lastError ? 500 : 0));
      if (this.store.worker(id).lastError) this.wake(id);
    }
  }

  private async child(id: string): Promise<void> {
    this.busy.add(id);
    try {
      const child = this.store.state.children.find((child) => child.id === id)!;
      const workspace = this.store.worker(child.parent).workspace;
      this.store.update((state) => { state.children.find((child) => child.id === id)!.status = "running"; });
      const handle = await this.open({
        id, model: this.store.state.config.subagentModel, workspace,
        threadId: child.threadId, accountedTokens: child.accountedTokens,
        onTotalUsage: (tokens) => this.store.update((state) => { state.children.find((child) => child.id === id)!.accountedTokens = tokens; }),
        onApprovalRequired: (reason) => { void this.pause(reason); },
        onSession: (path) => this.store.update((state) => { state.children.find((child) => child.id === id)!.threadId = path; }),
        system: `You are ${id}, a focused helper for ${child.parent}. Communicate only with your parent through your final response. You have no board, DMs, or delegation tools. Never launch agents through shell commands. Work on the parent's bounded task in their workspace and return findings, changed paths, and verification evidence. Other helpers may share this workspace; do not edit unrelated files. Do not seek model identity or private swarm configuration. Codex native sandbox and automatic approval review apply. ${this.store.state.config.webSearch === false ? "Web search/browser tools are disabled. Do not use network research or launch web tools through shell commands." : "Built-in web search is available."} Respect denials.`,
        tools: [],
      });
      if (this.store.state.children.find((child) => child.id === id)!.status === "cancelling") return;
      const output = await handle.prompt(`Parent's task:\n${child.task}`);
      if (this.store.state.status === "running") {
        this.store.update((state) => {
          const current = state.children.find((child) => child.id === id)!;
          if (!["cancelled", "cancelling"].includes(current.status)) { current.status = "completed"; current.result = this.safeReason(output); }
        });
        this.store.event("subagent", "Report ready for parent", id);
      }
    } catch (error) {
      if (this.store.state.status === "running") this.store.update((state) => {
        const child = state.children.find((child) => child.id === id)!;
        if (!["cancelled", "cancelling"].includes(child.status)) { child.status = "failed"; child.result = this.safeReason(error instanceof Error ? error.message : String(error)); }
      });
    } finally {
      this.close(id); this.busy.delete(id);
      if (this.store.state.children.find((child) => child.id === id)?.status === "cancelling") this.store.update((state) => { state.children.find((child) => child.id === id)!.status = "cancelled"; });
      this.wake(this.store.state.children.find((child) => child.id === id)!.parent);
    }
  }
  async cancelChild(id: string): Promise<void> {
    this.store.update((state) => {
      const child = state.children.find((child) => child.id === id);
      if (!child) throw new Error("Unknown subagent.");
      if (!["pending", "running", "cancelling"].includes(child.status)) throw new Error("This subagent is no longer active.");
      child.status = this.busy.has(id) ? "cancelling" : "cancelled"; child.result = "Cancelled by parent.";
    });
    await this.handles.get(id)?.abort();
  }

  async pause(reason = "Paused by user."): Promise<void> {
    if (this.store.state.status === "completed") return;
    if (this.store.state.status !== "paused") {
      this.store.update((state) => { state.status = "paused"; state.pauseReason = reason; });
      this.store.event("pause", reason, "system");
    }
    await this.stopHandles();
    await this.browser.close();
  }
  private stopHandles(): Promise<void> {
    if (!this.stopping) this.stopping = Promise.allSettled([...this.handles.values()].map((handle) => handle.abort())).then(() => {});
    return this.stopping;
  }
  async run(): Promise<void> {
    if (this.started) throw new Error("This engine has already been started.");
    this.started = true;
    if (this.store.state.status === "completed") throw new Error("This run is already completed.");
    const fresh = this.store.state.status === "ready";
    this.store.update((state) => {
      state.status = "running"; state.pauseReason = undefined;
      for (const worker of state.workers) {
        worker.status = state.tapouts[worker.id] ? "tapped_out" : "idle";
        // An explicit resume authorizes another recovery cycle for exhausted workers.
        if (worker.restarts > 3) worker.restarts = 0;
      }
      for (const child of state.children) {
        if (child.status === "running") child.status = "pending";
        if (child.status === "cancelling") child.status = "cancelled";
      }
    });
    this.store.event("run", "Swarm running", "system");
    this.lastClock = Date.now();
    for (const w of this.store.state.workers) if (fresh || !w.parked || this.userMessages(w.id).length) this.wake(w.id);
    try {
      while (this.store.state.status === "running") {
        const now = Date.now();
        this.store.update((state) => { const delta = now - this.lastClock; state.elapsedMs += delta; const phase = state.phase ?? "implementation"; state.phaseElapsedMs ??= {}; state.phaseElapsedMs[phase] = (state.phaseElapsedMs[phase] ?? 0) + delta; });
        this.lastClock = now;
        this.checkBudget();
        if (now - this.fileScanAt > 5000) { this.fileScanAt = now; this.launch(this.scanFiles()); }
        this.checkLiveness();
        for (const task of this.store.state.tasks) if (task.status === "open" && task.availableAt && Date.parse(task.availableAt) <= now && !task.availabilityNotified) {
          this.store.update(state => { state.tasks.find(t => t.id === task.id)!.availabilityNotified = true; });
          this.notify("task", undefined, task.id);
        }
        if (this.store.state.status !== "running") break;
        for (const child of this.store.state.children) if (child.status === "pending" && !this.busy.has(child.id)) this.launch(this.child(child.id));
        {
          for (const worker of this.store.state.workers) {
            if (this.busy.has(worker.id)) {
              const handle = this.handles.get(worker.id);
              // Workers pull routine coordination themselves. Only operator instructions steer a running turn.
              if (handle && !this.store.state.tapouts[worker.id] && !this.steering.has(worker.id)) {
                if (this.userMessages(worker.id).length) this.launch(this.steerUser(worker.id, handle));

              }
              continue;
            }
            if (this.store.state.tapouts[worker.id] || worker.status === "failed" || (worker.parked && !this.wakeups.has(worker.id))) continue;
            if (this.wakeups.has(worker.id) && now >= (this.nextTurn.get(worker.id) ?? 0)) this.launch(this.work(worker.id));
          }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
    } catch (error) {
      await this.pause(`Runtime failure: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      await this.stopHandles();
      await this.browser.close();
      await Promise.allSettled([...this.operations]);
      for (const id of this.handles.keys()) this.close(id);
      this.store.update((state) => {
        state.elapsedMs += Date.now() - this.lastClock;
        for (const worker of state.workers) if (worker.status === "running") worker.status = "idle";
        for (const child of state.children) if (child.status === "running") child.status = "pending";
      });
      this.store.event("run", `Swarm ${this.store.state.status}; outputs: ${this.store.state.artifacts?.find(item => item.number === this.store.state.frozenGeneration)?.snapshot ?? this.store.state.integration}`, "system");
    }
  }
}

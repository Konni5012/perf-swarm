import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "./driver.js";
import type { Engine } from "./engine.js";
import { publishArtifact } from "./workspaces.js";
import { ExperimentStore } from "./experiments.js";

export function result(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: {} };
}

export function workerTools(engine: Engine, actor: string): ToolDefinition[] {
  const store = engine.store;
  const optionalString = Type.Optional(Type.String());
  const optionalId = Type.Optional(Type.Integer({ minimum: 1 }));
  const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 }));
  const after = Type.Optional(Type.Integer({ minimum: 0 }));
  const experiments = new ExperimentStore(store.directory);
  const tools = [
    defineTool({ name: "swarm_sleep", description: "Park this worker between turns until a subscribed event arrives (routine board posts do not wake workers). Use when you have no immediate work; call this then end the turn. No repeated model polling is needed.", parameters: Type.Object({ tasks: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))), generation: Type.Optional(Type.Boolean()), board: Type.Optional(Type.Boolean()), dms: Type.Optional(Type.Boolean()) }), execute: async (_id, args) => { engine.park(actor, { dms: true, ...args }); return result({ parked: true, instruction: "End this turn. You will wake only on subscribed changes." }); } }),
    defineTool({
      name: "checkpoint", description: "Optional immutable snapshots and structured evidence for reviews that need them. Not required for tap-out. Freeze after implementation tasks/helpers finish; thaw with a material reason to resume implementation. Status returns advisory findings that affect outcomes, not permission to stop. Inaccessible evidence must describe actual attempts.",
      parameters: Type.Object({ action: Type.Union(["freeze", "thaw", "evidence", "status"].map(value => Type.Literal(value))), reason: optionalString, generation: Type.Optional(Type.Integer({ minimum: 1 })), requirement: optionalString, detail: optionalString, files: Type.Optional(Type.Array(Type.String())),
        status: Type.Optional(Type.Union(["verified", "partially_verified", "inaccessible", "unverified", "contradicted"].map(value => Type.Literal(value)))) }),
      execute: async (_id, args) => {
        if (args.action === "freeze") return result({ ...await engine.freeze(actor), instruction: "End this turn. Your next turn uses the frozen snapshot under the native read-only sandbox; validate it and record evidence." });
        if (args.action === "thaw") { engine.thaw(actor, args.reason ?? ""); return result(store.readiness()); }
        if (args.action === "evidence") { const evidence = store.evidence(actor, { generation: args.generation ?? 0, requirement: args.requirement ?? "", detail: args.detail ?? "", status: args.status ?? "unverified", files: args.files ? Object.fromEntries(args.files.map(path => { const hash = store.state.artifacts?.find(a => a.number === args.generation)?.files[path]; if (!hash) throw new Error(`Unknown evidence dependency: ${path}`); return [path, hash]; })) : undefined }); if (["unverified", "contradicted"].includes(evidence.status) && store.state.integrator) engine.wake(store.state.integrator, true); return result(evidence); }
        return result(store.readiness());
      },
    }),
    defineTool({
      name: "swarm_status", label: "Swarm status", description: "Read the objective, worker IDs, tasks, tap-outs, outcome and your helper reports. Message counts are included; pull message content with board and dm. No model information is available.", parameters: Type.Object({}),
      execute: async () => result(store.coordinationView(actor)),
    }),
    defineTool({
      name: "coordination_snapshot", label: "Coordination snapshot", description: "Read one compact snapshot containing changed tasks/status plus new board posts and your private DMs since your previous pull; reset requests full context. Prefer this over separate swarm_status, board, and dm polling at the start of a turn.",
      parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), reset: Type.Optional(Type.Boolean()) }),
      execute: async (_id, args) => result(store.coordinationSnapshot(actor, args.limit, args.reset)),
    }),
    defineTool({
      name: "board", label: "Message board", description: "Pull the last N shared board posts with action read and limit (default 20, max 1000), optionally after a message ID. Results are chronological. Post returns only a receipt. Everyone can read board posts.",
      parameters: Type.Object({ action: Type.Union([Type.Literal("read"), Type.Literal("post")]), text: optionalString, limit, after }),
      execute: async (_id, args) => {
        if (args.action === "post") { const post = store.post(actor, args.text ?? ""); engine.notify("board", actor); return result({ id: post.id, at: post.at }); }
        return result(store.readBoard(args.limit, args.after));
      },
    }),
    defineTool({
      name: "dm", label: "Direct message", description: "Send a DM to a worker or user; sending returns only a receipt. Pull the last N messages in your own conversations with action read and limit (default 20, max 1000), optionally after an ID or filtered by peer using to. Results are chronological. Other workers' conversations are private.",
      parameters: Type.Object({ action: Type.Union([Type.Literal("read"), Type.Literal("send"), Type.Literal("ack")]), to: optionalString, text: optionalString, limit, after, id: optionalId, requiresAck: Type.Optional(Type.Boolean()), ackTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })), replyTo: optionalId }),
      execute: async (_id, args) => {
        if (args.action === "send") { const dm = store.dm(actor, args.to ?? "", args.text ?? "", args); if (store.state.workers.find(w => w.id === dm.to)?.subscription?.dms !== false && dm.to !== "user" && !store.state.tapouts[dm.to]) engine.wake(dm.to); return result({ id: dm.id, to: dm.to, at: dm.at, status: dm.status }); }
        if (args.action === "ack") return result(store.acknowledgeDm(actor, args.id ?? 0));
        return result(store.readDms(actor, args.limit, args.after, args.to));
      },
    }),
    defineTool({
      name: "swarm_wait", label: "Subscribe to changes", description: "Park until specified tasks close, a new generation appears, or selected messages arrive. Returns immediately; end this turn. The scheduler waits without model calls or timeout polling.",
      parameters: Type.Object({ tasks: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))), generation: Type.Optional(Type.Boolean()), board: Type.Optional(Type.Boolean()), dms: Type.Optional(Type.Boolean()) }),
      execute: async (_id, args) => { for (const id of args.tasks ?? []) if (!store.state.tasks.some(t => t.id === id)) throw new Error(`Unknown subscription task ${id}`); const ready = (args.tasks ?? []).filter(id => store.state.tasks.some(t => t.id === id && ["done", "cancelled"].includes(t.status))); if (ready.length) return result({ subscribed: false, ready, instruction: "These dependencies are already closed. Act on their result now; do not poll or resubscribe to them." }); engine.park(actor, { dms: true, ...args }); return result({ subscribed: true, instruction: "End this turn; no polling required." }); },
    }),
    defineTool({
      name: "task", label: "Task board", description: "Self-organize: create tasks, atomically claim open tasks, complete your claimed tasks with evidence, or release them. No coordinator assigns work.",
      parameters: Type.Object({ action: Type.Union(["list", "create", "claim", "complete", "release", "cancel"].map((value) => Type.Literal(value))), id: optionalId, title: optionalString, description: optionalString, result: optionalString, kind: Type.Optional(Type.Union([Type.Literal("implementation"), Type.Literal("validation")])), generation: Type.Optional(Type.Integer({ minimum: 1 })), contingencyFor: optionalString, blockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))), supersededBy: optionalId, delayMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600000 })) }),
      execute: async (_id, args) => {
        if (args.action === "list") return result(store.state.tasks);
        const task = store.task(actor, args.action, args);
        engine.notify("task", actor, task.id);
        return result(task);
      },
    }),
    defineTool({
      name: "integrator", label: "Integration ownership", description: "Volunteer to combine outputs by claiming integration ownership. Coordinate by board/DM before taking it. Release ownership when handing off.",
      parameters: Type.Object({ action: Type.Union([Type.Literal("claim"), Type.Literal("release"), Type.Literal("status")]) }),
      execute: async (_id, args) => {
        if (args.action === "claim") store.electIntegrator(actor);
        if (args.action === "release") store.update((state) => {
          if (state.integrator !== actor) throw new Error("Only the integrator can release ownership.");
          state.integrator = undefined;
        });
        return result({ owner: store.state.integrator, workspace: store.state.integration });
      },
    }),
    defineTool({
      name: "integrate", label: "Combine outputs", description: "Integrator only: prepare a worker Git merge; publish a worker file; or switch between integration and your own workspace. Other workers coordinate through the integrator. workspace switches the native cwd on the NEXT turn; end this turn after switching. merge prepares a fixed merge command, which you execute with native shell on the next turn. publish copies a regular artifact file.",
      parameters: Type.Object({ action: Type.Union([Type.Literal("merge"), Type.Literal("publish"), Type.Literal("workspace")]), worker: optionalString, path: optionalString, destination: optionalString, target: Type.Optional(Type.Union([Type.Literal("integration"), Type.Literal("worker")])) }),
      execute: async (_id, args) => {
        if (store.state.integrator !== actor) throw new Error("Claim integration ownership first.");
        if (store.state.frozenGeneration !== undefined) throw new Error("Integration is frozen; explicitly thaw before changing it.");
        try {
          if (args.action === "publish") return result(await engine.publish(actor, () => publishArtifact(store.state, store.worker(args.worker ?? "").id, args.path ?? "", args.destination ?? args.path ?? "")));
          const worker = store.worker(actor);
          if (args.action === "merge") {
            const source = store.worker(args.worker ?? "");
            if (!store.state.git || !source.branch) throw new Error("Git merging requires repository worktrees.");
            const generation = store.state.artifactGeneration ?? 0;
            store.update((state) => { state.workers.find((item) => item.id === actor)!.integrationMode = true; });
            return result({ workspace: store.state.integration, generation, nextTurn: true, command: `git -c user.name=SWARM -c user.email=swarm@localhost merge --no-edit ${source.branch}`, instruction: "Ensure the source worker has committed all changes. End this turn. On your next turn, execute this command with the native Codex shell in integration, under native sandbox/review. Resolve conflicts there." });
          }
          const integration = args.target !== "worker";
          store.update((state) => { state.workers.find((item) => item.id === actor)!.integrationMode = integration; });
          return result({ workspace: integration ? store.state.integration : worker.workspace, nextTurn: true, instruction: "End this turn now. Your next turn uses this native working directory and sandbox." });
        } finally { engine.wake(actor); }
      },
    }),
    defineTool({
      name: "subagent", label: "Parent-only subagents", description: "Spawn focused helpers (max four active). Helpers use the user-selected model, share your workspace, report only to you, and cannot spawn agents. Spawn returns immediately; read results later or cancel. You cannot select their model.",
      parameters: Type.Object({ action: Type.Union([Type.Literal("spawn"), Type.Literal("list"), Type.Literal("result"), Type.Literal("cancel")]), task: optionalString, id: optionalString }),
      execute: async (_id, args) => {
        if (args.action === "spawn") return result({ id: store.reserveChild(actor, args.task ?? ""), status: "pending" });
        const children = store.state.children.filter((child) => child.parent === actor);
        if (args.action === "list") return result(children.map(({ id, task, status, result: report }) => ({ id, task, status, result: report })));
        const child = children.find((child) => child.id === args.id);
        if (!child) throw new Error("No such subagent belonging to you.");
        if (args.action === "cancel") await engine.cancelChild(child.id);
        const current = store.state.children.find((item) => item.id === child.id)!;
        return result({ id: current.id, status: current.status, result: current.result });
      },
    }),
    defineTool({
      name: "tap_out", label: "Finish contribution", description: "Finish with complete, blocked, or partial and concrete findings. Automatically closes owned tasks. Freeze and structured evidence are optional; finish/cancel active helpers first. Unresolved findings affect the outcome, not permission to stop. Routine notifications will not wake you. All workers tapped out ends the run.",
      parameters: Type.Object({ outcome: Type.Union(["complete", "blocked", "partial"].map(v => Type.Literal(v))), reason: Type.String({ minLength: 1 }) }),
      execute: async (_id, args) => {
        const closing = store.state.tasks.filter(t => t.owner === actor && !["done", "cancelled"].includes(t.status)).map(t => t.id);
        store.tapOut(actor, args.outcome, args.reason);
        for (const id of closing) engine.notify("task", actor, id);
        return result({ tapouts: store.state.tapouts, outcome: store.state.outcome, instruction: "End this turn." }); },
    }),
    defineTool({
      name: "experiment", label: "Experiment ledger", description: "Record every engineering attempt as durable evidence. Create hypotheses, checkpoint observations, finish attempts as succeeded/failed/blocked/inconclusive, and search prior attempts before repeating work. Finished attempts are immutable; create a new linked attempt for retries or variations.",
      parameters: Type.Object({
        action: Type.Union(["create", "checkpoint", "finish", "list", "get"].map(value => Type.Literal(value))),
        id: optionalString, hypothesis: optionalString, parent: optionalString, note: optionalString, result: optionalString, failureCategory: optionalString,
        status: Type.Optional(Type.Union(["succeeded", "failed", "blocked", "inconclusive", "superseded"].map(value => Type.Literal(value)))),
        query: optionalString, tags: Type.Optional(Type.Array(Type.String())), metrics: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])))
      }),
      execute: async (_id, args) => {
        if (args.action === "create") return result(await experiments.create({ actor, objective: store.state.objective, hypothesis: args.hypothesis ?? "", workspace: store.worker(actor).workspace, parent: args.parent, tags: args.tags }));
        if (args.action === "list") return result(await experiments.list({ query: args.query, actor }));
        if (args.action === "get") return result(await experiments.get(args.id ?? ""));
        if (args.action === "checkpoint") { await experiments.checkpoint(args.id ?? "", actor, args.note ?? "", args.metrics); return result(await experiments.get(args.id ?? "")); }
        return result(await experiments.finish(args.id ?? "", actor, { status: args.status ?? "inconclusive", result: args.result ?? "", failureCategory: args.failureCategory, metrics: args.metrics, tags: args.tags }));
      },
    }),
    defineTool({
      name: "browser", label: "Scoped browser", description: "Use SWARM's background browser companion. Each worker owns an isolated profile and offscreen tabs. It does not operate the user's desktop or physical pointer. Browser-local keyboard and coordinate input is supported. Navigate public http(s) pages, inspect readable page text, click a CSS selector, capture a real screenshot, resize the viewport, or preview static files in your authorized workspace/frozen snapshot (optional url is a relative/absolute local entry path, including nested index.html). Navigation returns HTTP/challenge diagnostics and shares bounded access failures. Browser access is separate from native desktop Computer Use.",
      parameters: Type.Object({ action: Type.Union(["navigate", "snapshot", "click", "screenshot", "viewport", "preview", "type", "press", "scroll", "click_at", "tabs", "new_tab", "select_tab", "close_tab"].map(value => Type.Literal(value))), url: optionalString, selector: optionalString, text: optionalString, key: optionalString, tab: optionalString, x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), width: Type.Optional(Type.Integer({ minimum: 240, maximum: 4096 })), height: Type.Optional(Type.Integer({ minimum: 240, maximum: 4096 })) }),
      execute: async (_id, args) => {
        if (args.action === "tabs") return result(await engine.browser.tabs(actor));
        if (args.action === "new_tab") return result(await engine.browser.newTab(actor, args.url));
        if (args.action === "select_tab") return result(await engine.browser.selectTab(actor, args.tab ?? ""));
        if (args.action === "close_tab") return result(await engine.browser.closeTab(actor, args.tab ?? ""));
        if (args.action === "type") return result(await engine.browser.type(actor, args.text ?? "", args.selector));
        if (args.action === "press") return result(await engine.browser.press(actor, args.key ?? ""));
        if (args.action === "scroll") return result(await engine.browser.scroll(actor, args.x ?? 0, args.y ?? 600));
        if (args.action === "click_at") return result(await engine.browser.clickAt(actor, args.x ?? 0, args.y ?? 0));
        if (args.action === "navigate") return result(await engine.browser.navigate(actor, args.url ?? ""));
        if (args.action === "snapshot") return result(await engine.browser.snapshot(actor));
        if (args.action === "click") return result(await engine.browser.click(actor, args.selector ?? ""));
        if (args.action === "viewport") return result(await engine.browser.viewport(actor, args.width ?? 1440, args.height ?? 900));
        if (args.action === "preview") return result(await engine.browser.preview(actor, store.state.artifacts?.find(a => a.number === store.state.frozenGeneration)?.snapshot ?? (store.worker(actor).integrationMode && store.state.integrator === actor ? store.state.integration : store.worker(actor).workspace), args.url));
        const screenshot = await engine.browser.screenshot(actor);
        return { content: [{ type: "text" as const, text: JSON.stringify({ worker: actor, url: screenshot.url }) }, { type: "image" as const, imageUrl: `data:image/png;base64,${screenshot.screenshotBase64}` }] };
      },
    }),
  ];
  return tools.filter(tool => tool.name !== "browser" || store.state.config.webSearch !== false).map((tool) => ({ ...tool, execute: async (id, args, signal) => {
    engine.assertRunning();
    if (store.state.tapouts[actor]) throw new Error("You tapped out. End this turn; wait for relevant reactivation.");
    if (signal?.aborted) throw new Error("Tool call cancelled.");
    engine.store.event("tool", tool.name, actor);
    engine.heartbeat(actor, `tool:${tool.name}`);
    return tool.execute(id, args, signal);
  } }));
}

import { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { AppServer, type RpcMessage } from "./protocol.js";
import type { RunConfig, TelemetryEvent } from "./types.js";
import { computerUseConfig } from "./computer-use.js";
import { BrowserProvider } from "./browser.js";

export type ToolContent = { type: "text"; text: string } | { type: "image"; imageUrl: string };
export interface ToolDefinition {
  name: string; description: string; parameters: TSchema;
  execute(id: string, args: any, signal?: AbortSignal): Promise<{ content: ToolContent[] }>;
}
export function defineTool<T extends TSchema>(tool: { name: string; label?: string; description: string; parameters: T; execute(id: string, args: Static<T>, signal?: AbortSignal): Promise<{ content: ToolContent[] }> }): ToolDefinition { return tool; }
export interface AgentHandle {
  prompt(text: string): Promise<string>; steer(text: string): Promise<boolean>;
  abort(): Promise<void>; dispose(): void;
}
export interface AgentOptions {
  id: string; model: string; workspace: string; system: string;
  threadId?: string; accountedTokens?: number; ephemeral?: boolean; readOnly?: boolean;
  currentWorkspace?: () => string;
  currentReadOnly?: () => boolean;
  computerUse?: boolean;
  tools: ToolDefinition[];
  onSession?: (threadId: string) => void;
  onUsage: (tokens: number) => void;
  onTotalUsage?: (tokens: number) => void;
  onText?: (text: string) => void;
  onApprovalRequired?: (reason: string) => void;
  onReview?: (status: string, reason: string) => void;
  onTelemetry?: (event: TelemetryEvent) => void;
}
export interface AgentDriver { create(options: AgentOptions): Promise<AgentHandle> }
export const NATIVE_CONFIG = {
  "features.multi_agent": false, "features.multi_agent_v2": false,
  "features.agent_message_board": false, "features.apps": false,
  "features.plugins": false, "features.tool_suggest": false,
  "web_search": "live", "tools.web_search": true, "sandbox_workspace_write.network_access": false,
  "sandbox_workspace_write.writable_roots": [],
  "sandbox_workspace_write.exclude_tmpdir_env_var": true,
  "sandbox_workspace_write.exclude_slash_tmp": true,
};
export function sandboxPolicy(cwd: string, readOnly = false) {
  return readOnly ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
}
export class CodexDriver implements AgentDriver {
  constructor(readonly server: AppServer, readonly config: RunConfig) {}
  async preflight(): Promise<NonNullable<RunConfig["capabilities"]>> {
    if (!this.config.computerUseManifest) {
      const browser = this.config.webSearch === false ? "disabled" : await new BrowserProvider({ backend: this.config.browserBackend }).ready() ? "ready" : "unavailable";
      if (browser === "unavailable") throw new Error("SWARM browser runtime unavailable. For electron install Electron; for chromium install Playwright Chromium; for chrome start Docker and run npm run browser:chrome:build.");
      return { webSearch: this.config.webSearch !== false, computerUse: "disabled", browser, detail: "SWARM-owned browser sessions, launched lazily on first use. Personal browsers and native desktop Computer Use are disconnected." };
    }
    let threadId = "";
    const handle = await this.create({ id: "capability-preflight", model: this.config.model, workspace: process.cwd(), system: "Capability discovery only. Do not operate apps.", tools: [], computerUse: true, ephemeral: true, onUsage: () => {}, onSession: id => { threadId = id; } });
    try {
      const response = await this.server.request("mcpServerStatus/list", { threadId, serverName: "cua_repl" }, 130_000);
      const service = response.data?.find((item: any) => item.name === "cua_repl");
      if (service?.runtimeStatus !== "connected" || !service.tools?.js || !service.tools?.js_reset) throw new Error("Computer Use preflight failed: required app MCP tools are not connected.");
      let browser = "unavailable" as "ready" | "unavailable";
      try {
        const inventory = await this.server.request("mcpServer/tool/call", { threadId, server: "cua_repl", tool: "js", arguments: { code: "JSON.stringify(await cua.getState())" } }, 130_000);
        const text = inventory.result?.content?.map((item: any) => item.text ?? "").join(" ") ?? "";
        const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
        const browsers = parsed?.browsers ?? parsed?.browser?.browsers ?? [];
        browser = Array.isArray(browsers) && browsers.length > 0 ? "ready" : "unavailable";
      } catch { browser = "unavailable"; }
      if (browser === "unavailable") browser = await new BrowserProvider().ready() ? "ready" : "unavailable";
      const detail = browser === "ready"
        ? "Computer Use MCP and SWARM's isolated browser provider are available. App grants, screenshot capture, target URL accessibility and rendering remain runtime checks."
        : "Computer Use MCP is connected, but neither the host nor SWARM exposed a browser provider.";
      return { webSearch: this.config.webSearch !== false, computerUse: "connected", browser, detail };
    } finally { handle.dispose(); }
  }
  async create(options: AgentOptions): Promise<AgentHandle> {
    // Disable inherited MCP servers: helpers must have no alternate coordination/delegation tools.
    const effective = await this.server.request("config/read", { cwd: options.workspace, includeLayers: false });
    const disabledMcp: Record<string, boolean> = {};
    for (const name of Object.keys(effective.config?.mcp_servers ?? {})) disabledMcp[`mcp_servers.${name}.enabled`] = false;
    const effort = this.config.modelThinking?.[options.model] ?? this.config.thinking;
    const noWeb = this.config.webSearch === false ? {
      web_search: "disabled", "tools.web_search": false,
      "features.browser_use": false, "features.browser_use_external": false,
      "features.computer_use": false, "features.in_app_browser": false,
      "features.image_generation": false,
    } : {};
    const useComputer = options.computerUse === true && !options.readOnly && !!this.config.computerUseManifest;
    if (useComputer && this.config.webSearch === false) throw new Error("Computer Use is disabled by --no-web-search.");
    // Replace rather than inherit the CUA definition; leave every unrelated server disabled.
    if (useComputer) delete disabledMcp["mcp_servers.cua_repl.enabled"];
    const computer = useComputer ? await computerUseConfig(this.config.computerUseManifest!) : {
      "features.browser_use": false, "features.browser_use_external": false,
      "features.computer_use": false, "features.in_app_browser": false,
    };
    const readOnly = options.currentReadOnly?.() ?? options.readOnly;
    const settings = { model: options.model, cwd: options.workspace, approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: readOnly ? "read-only" : "workspace-write", developerInstructions: options.system, config: { ...NATIVE_CONFIG, ...disabledMcp, ...computer, ...noWeb, model_reasoning_effort: effort } };
    const reply = await this.server.request(options.threadId ? "thread/resume" : "thread/start", options.threadId ? { ...settings, threadId: options.threadId } : { ...settings, ephemeral: options.ephemeral ?? false, dynamicTools: options.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.parameters })) });
    if (reply.approvalPolicy !== "on-request" || reply.approvalsReviewer !== "auto_review" || reply.sandbox?.type !== (readOnly ? "readOnly" : "workspaceWrite")) throw new Error("Codex did not apply the required native sandbox and automatic review settings.");
    const threadId: string = reply.thread.id;
    options.onSession?.(threadId);
    const computerTurns = new Map<string, Promise<void>>();
    const endComputerTurn = (turnId?: string): Promise<void> => {
      if (!useComputer || !turnId) return Promise.resolve();
      const existing = computerTurns.get(turnId);
      if (existing) return existing;
      // Mirror the app plugin's Stop hook so native app access is released.
      const ending = this.server.request("mcpServer/tool/call", {
        threadId, server: "cua_repl", tool: "turn_ended",
        arguments: { hook_event_name: "Stop", session_id: threadId, turn_id: turnId },
      }).then((result) => {
        if (result.isError || result.result?.isError) throw new Error("Computer Use turn cleanup failed.");
      });
      computerTurns.set(turnId, ending);
      if (computerTurns.size > 2) computerTurns.delete(computerTurns.keys().next().value!);
      return ending;
    };
    type ActiveTurn = { ready: Promise<void>; markReady: () => void; id?: string; resolve: (text: string) => void; reject: (error: Error) => void; messages: Map<string, string> };
    let active: ActiveTurn | undefined;
    let total = options.accountedTokens ?? 0;
    let disposed = false;
    const controller = new AbortController();
    const record = (event: Omit<TelemetryEvent, "at" | "actor">) => options.onTelemetry?.({ ...event, at: new Date().toISOString(), actor: options.id });
    const onClosed = (error: Error) => { if (active?.id) record({ kind: "turn-end", turnId: active.id, status: "failed", detail: error.message }); active?.markReady(); active?.reject(error); active = undefined; };
    const onNotification = (event: RpcMessage) => {
      const p = event.params;
      if (p?.threadId !== threadId) return;
      if (event.method === "thread/tokenUsage/updated") {
        const next = p.tokenUsage.total.totalTokens;
        if (Number.isFinite(next) && next > total) { const delta = next - total; total = next; options.onTotalUsage?.(total); options.onUsage(delta); record({ kind: "usage", turnId: p.turnId ?? active?.id, tokens: delta }); }
      }
      if (event.method === "item/autoApprovalReview/completed") options.onReview?.(p.review.status, p.review.rationale ?? "Codex did not supply a rationale.");
      if (event.method === "autoApprovalReview/strictReviewRequired") options.onApprovalRequired?.("Codex requires strict operator review. The run has been paused for inspection.");
      if (!active) return;
      if (event.method === "turn/started") { active.id = p.turn.id; active.markReady(); record({ kind: "turn-start", turnId: p.turn.id }); }
      if (["item/started", "item/completed"].includes(event.method ?? "") && p.item?.type !== "reasoning") {
        const item = p.item;
        const detail = item.command ? `${item.command}${item.aggregatedOutput ? "\n" + item.aggregatedOutput : ""}` : item.text ?? (item.tool ? JSON.stringify({ tool: item.tool, arguments: item.arguments, output: item.contentItems ?? item.output }) : item.changes ? JSON.stringify(item.changes) : item.query ?? "");
        record({ kind: event.method === "item/started" ? "item-start" : "item-end", turnId: p.turnId ?? active.id, itemId: item.id, itemType: item.type, status: item.status, detail: String(detail).slice(0, 12000) });
      }
      if (event.method === "item/agentMessage/delta") { active.messages.set(p.itemId, (active.messages.get(p.itemId) ?? "") + p.delta); options.onText?.(p.delta); }
      if (event.method === "item/completed" && p.item.type === "agentMessage") active.messages.set(p.item.id, p.item.text);
      if (event.method === "turn/completed" && (!active.id || p.turn.id === active.id)) {
        record({ kind: "turn-end", turnId: p.turn.id, status: p.turn.status });
        const current = active; current.markReady(); active = undefined;
        void endComputerTurn(p.turn.id).then(() => {
          if (p.turn.status !== "completed") current.reject(new Error(p.turn.error?.message ?? `Codex turn ${p.turn.status}`));
          else current.resolve([...current.messages.values()].join("\n"));
        }).catch(error => { options.onApprovalRequired?.(`Computer Use cleanup failed: ${String(error)}`); current.reject(error); });
      }
    };
    const onRequest = (event: RpcMessage) => {
      if (event.params?.threadId !== threadId || event.id === undefined) return;
      void (async () => {
        if (event.method === "item/tool/call") {
          try {
            if (!active?.id || active.id !== event.params.turnId || controller.signal.aborted) throw new Error("Tool call outside its active turn.");
            const tool = options.tools.find((tool) => tool.name === event.params.tool);
            if (!tool || event.params.namespace) throw new Error("Tool unavailable for this agent role.");
            if (!Check(tool.parameters, event.params.arguments)) throw new Error("Invalid tool arguments.");
            const output = await tool.execute(event.params.callId, event.params.arguments, controller.signal);
            if (!disposed) this.server.respond(event.id!, { success: true, contentItems: output.content.map((item) => (item.type === "image" ? { type: "inputImage", imageUrl: item.imageUrl } : { type: "inputText", text: item.text })) });
          } catch (error) { if (!disposed) this.server.respond(event.id!, { success: false, contentItems: [{ type: "inputText", text: String(error) }] }); }
        } else {
          // Auto-review is handled inside Codex. A request reaching the host needs human attention.
          const reason = `Codex requires operator input: ${event.method}. ${event.params.reason ?? ""}`.trim();
          if (event.method === "item/commandExecution/requestApproval" || event.method === "item/fileChange/requestApproval") this.server.respond(event.id!, { decision: "decline" });
          else if (event.method === "item/permissions/requestApproval") this.server.respond(event.id!, { permissions: {}, scope: "turn" });
          else this.server.reject(event.id!, reason);
          options.onApprovalRequired?.(reason);
          active?.markReady(); active?.reject(new Error(reason)); active = undefined;
        }
      })().catch((error) => onClosed(error instanceof Error ? error : new Error(String(error))));
    };
    this.server.on("notification", onNotification); this.server.on("request", onRequest); this.server.on("closed", onClosed);
    const handle: AgentHandle = {
      prompt: async (text) => {
        if (disposed || active) throw new Error("Agent is disposed or already running.");
        let resolveTurn!: (text: string) => void;
        let rejectTurn!: (error: Error) => void;
        const completed = new Promise<string>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
        let markReady!: () => void;
        const ready = new Promise<void>((resolve) => { markReady = resolve; });
        const turn: ActiveTurn = { ready, markReady, resolve: resolveTurn, reject: rejectTurn, messages: new Map() };
        active = turn;
        // Attach immediately: completion/exit can arrive before the start response.
        void completed.catch(() => {});
        try {
          const cwd = options.currentWorkspace?.() ?? options.workspace;
          const started = await this.server.request("turn/start", { threadId, cwd, approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: sandboxPolicy(cwd, options.currentReadOnly?.() ?? options.readOnly), effort, input: [{ type: "text", text, text_elements: [] }] });
          if (controller.signal.aborted || disposed) { await this.server.request("turn/interrupt", { threadId, turnId: started.turn.id }, 10000).catch(() => {}); }
          else if (active === turn) { active.id = started.turn.id; active.markReady(); }
        } catch (error) { if (active === turn) active = undefined; turn.markReady(); turn.reject(error instanceof Error ? error : new Error(String(error))); }
        return completed;
      },
      steer: async (text) => { const turn = active; if (!turn) return false; await turn.ready; if (active !== turn || !turn.id) return false; await this.server.request("turn/steer", { threadId, expectedTurnId: turn.id, input: [{ type: "text", text, text_elements: [] }] }); return true; },
      abort: async () => { controller.abort(); const current = active; if (current?.id) await this.server.request("turn/interrupt", { threadId, turnId: current.id }, 10000).catch(() => {}); await endComputerTurn(current?.id); if (active === current && current?.id) record({ kind: "turn-end", turnId: current.id, status: "interrupted" }); current?.markReady(); current?.reject(new Error("Agent interrupted.")); if (active === current) active = undefined; },
      dispose: () => { if (disposed) return; const turnId = active?.id; disposed = true; controller.abort(); void endComputerTurn(turnId).catch(error => options.onApprovalRequired?.(`Computer Use cleanup failed: ${String(error)}`)); onClosed(new Error("Agent disposed.")); this.server.off("notification", onNotification); this.server.off("request", onRequest); this.server.off("closed", onClosed); void this.server.request("thread/unsubscribe", { threadId }, 5000).catch(() => {}); },
    };
    return handle;
  }
}
export async function connectCodex(): Promise<AppServer> {
  const server = new AppServer();
  try { await server.initialize(); return server; } catch (error) { server.dispose(); throw error; }
}
export async function validateModels(server: AppServer, ids: string[]): Promise<void> {
  const account = await server.request("account/read", { refreshToken: false });
  if (!account.account) throw new Error("Codex authentication is missing. Run 'perf-swarm login' first.");
  const models = await listModels(server);
  for (const id of new Set(ids)) if (!models.includes(id)) throw new Error(`Unknown Codex model '${id}'. Run 'perf-swarm models' for available IDs.`);
}
export async function listModels(server: AppServer): Promise<string[]> {
  const models: string[] = []; let cursor: string | null = null;
  do { const page = await server.request("model/list", { cursor, limit: 100 }); models.push(...page.data.map((model: any) => model.model)); cursor = page.nextCursor; } while (cursor);
  return models;
}
export function parseJsonReply(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
}

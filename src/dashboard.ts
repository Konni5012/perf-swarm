import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent, RunState, TelemetryEvent } from "./types.js";

export interface Span {
  id: string; actor: string; start: number; end?: number; status: string;
  tokens?: number; detail?: string; type: string; parent?: string; inferred?: boolean;
}
const cache = new Map<string, { stamp: string; value: unknown }>();
async function load(path: string, lines = false): Promise<any> {
  try {
    const info = await stat(path); const stamp = `${info.mtimeMs}:${info.size}`;
    if (cache.get(path)?.stamp === stamp) return cache.get(path)!.value;
    const text = await readFile(path, "utf8");
    const value = lines ? text.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }) : JSON.parse(text);
    cache.set(path, { stamp, value }); return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return lines ? [] : undefined; throw error; }
}
/** Discover run directories, stopping at each run rather than descending into its workspaces. */
export async function discoverRuns(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>(); const base = await realpath(root);
  async function visit(path: string, depth: number) {
    const state = await load(join(path, "state.json"));
    if (state?.version === 4 && Array.isArray(state.workers)) { found.set(relative(base, path) || ".", path); return; }
    if (depth >= 3) return;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(join(path, entry.name), depth + 1);
    }
  }
  await visit(base, 0); return found;
}
export function buildSpans(state: RunState, events: RunEvent[], telemetry: TelemetryEvent[], now = Date.now()): Span[] {
  const spans = new Map<string, Span>();
  const measuredActors = new Map<string, number>();
  for (const event of telemetry) if (event.kind === "turn-start") measuredActors.set(event.actor, Math.min(measuredActors.get(event.actor) ?? Infinity, Date.parse(event.at)));
  const pending = new Map<string, Span>();
  const close = (actor: string, end: number, status: string) => { const span = pending.get(actor); if (span) { span.end = Math.max(span.start, end); span.status = status; pending.delete(actor); } };
  events.forEach((event, index) => {
    const at = Date.parse(event.at); const actor = event.actor ?? "system";
    if (event.type === "worker" && event.message === "Working" && at < (measuredActors.get(actor) ?? Infinity)) {
      close(actor, at, "recorded");
      const span: Span = { id: `legacy-${index}`, actor, start: at, status: "running", type: "turn", inferred: true };
      spans.set(span.id, span); pending.set(actor, span);
    }
    if (["output", "recovery"].includes(event.type)) close(actor, at, event.type === "recovery" ? "failed" : "completed");
    if (event.type === "pause" || (event.type === "run" && /paused|completed/.test(event.message))) for (const id of pending.keys()) close(id, at, "interrupted");
  });
  for (const event of telemetry) {
    const at = Date.parse(event.at); if (!Number.isFinite(at)) continue;
    const key = `${event.actor}:${event.turnId}`;
    if (event.kind === "turn-start" && event.turnId) {
      close(event.actor, at, "recorded");
      const existing = spans.get(key);
      spans.set(key, { ...existing, id: key, actor: event.actor, start: Math.min(existing?.start ?? at, at), status: existing?.status ?? "running", type: "turn", tokens: existing?.tokens ?? 0 });
    }
    if (event.kind === "turn-end" && spans.has(key)) { const span = spans.get(key)!; span.end = at; span.status = event.status ?? "completed"; }
    if (event.kind === "usage" && spans.has(key)) spans.get(key)!.tokens = (spans.get(key)!.tokens ?? 0) + (event.tokens ?? 0);
    if ((event.kind === "item-start" || event.kind === "item-end") && event.itemId) {
      const id = `${key}:${event.itemId}`; const old = spans.get(id);
      spans.set(id, { id, parent: key, actor: event.actor, start: old?.start ?? at, end: event.kind === "item-end" ? at : old?.end, status: event.status ?? (event.kind === "item-end" ? "completed" : "running"), type: event.itemType ?? "tool", detail: event.detail || old?.detail });
    }
  }
  const ended = state.status !== "running" ? Date.parse(events.at(-1)?.at ?? state.createdAt) : now;
  for (const span of spans.values()) if (!span.end && state.status !== "running") { span.end = Math.max(span.start, ended); span.status = "interrupted"; }
  return [...spans.values()].sort((a, b) => a.start - b.start);
}
export async function readDashboard(directory: string) {
  const state = await load(join(directory, "state.json")) as RunState;
  if (!state || state.version !== 4) throw new Error("Invalid run state");
  const events = await load(join(directory, "events.jsonl"), true) as RunEvent[];
  const telemetry = await load(join(directory, "telemetry.jsonl"), true) as TelemetryEvent[];
  const spans = buildSpans(state, events, telemetry);
  const agents = [
    ...state.workers.map((w) => ({ ...w, role: "worker", tokens: w.accountedTokens ?? 0 })),
    ...state.children.map((c) => ({ ...c, role: "helper", model: state.config.subagentModel, workspace: state.workers.find(w => w.id === c.parent)?.workspace, tokens: c.accountedTokens ?? 0 })),
  ].map((a) => ({ ...a, turns: spans.filter(s => s.type === "turn" && s.actor === a.id).length }));
  const unattributedTokens = Math.max(0, state.tokens - agents.reduce((sum, a) => sum + a.tokens, 0));
  return { state, events, spans, agents, unattributedTokens, capturedAt: new Date().toISOString(), precise: telemetry.length > 0 };
}
export async function startDashboard(options: { stateDir: string; port: number }): Promise<{ server: Server; url: string }> {
  const root = resolve(options.stateDir); await realpath(root);
  const assets = join(dirname(fileURLToPath(import.meta.url)), "gui-assets");
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    try {
      const host = request.headers.host ?? "";
      if (!/^127\.0\.0\.1:\d+$/.test(host)) { response.writeHead(403).end("Invalid host"); return; }
      if (request.headers.origin && request.headers.origin !== `http://${host}`) { response.writeHead(403).end("Invalid origin"); return; }
      if (request.method !== "GET") { response.writeHead(405).end("Read-only dashboard"); return; }
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (url.pathname === "/api/runs") {
        const runs = await discoverRuns(root);
        const result = await Promise.all([...runs].map(async ([key, path]) => { const s = await load(join(path, "state.json")) as RunState; return { key, id: s.id, objective: s.objective, status: s.status, createdAt: s.createdAt, tokens: s.tokens, agents: s.workers.length + s.children.length, model: s.config.model, elapsedMs: s.elapsedMs, messages: s.board.length + s.dms.length, threads: 1 + new Set(s.dms.map(dm => [dm.author, dm.to].sort().join(" ↔ "))).size, maxTokens: s.config.maxTokens }; }));
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))); return;
      }
      if (url.pathname === "/api/run") {
        const runs = await discoverRuns(root); const path = runs.get(url.searchParams.get("run") ?? "");
        if (!path) { response.writeHead(404).end("Run not found"); return; }
        const actual = await realpath(path); const base = await realpath(root);
        if (actual !== base && !actual.startsWith(base + sep)) { response.writeHead(403).end("Outside run root"); return; }
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(await readDashboard(actual))); return;
      }
      if (url.pathname === "/api/browser-frame") {
        const runs = await discoverRuns(root), path = runs.get(url.searchParams.get("run") ?? "");
        if (!path) { response.writeHead(404).end("Run not found"); return; }
        const state = await load(join(path, "state.json")) as RunState;
        const worker = url.searchParams.get("worker") ?? "";
        if (!state.workers.some(w => w.id === worker)) { response.writeHead(404).end("Unknown worker"); return; }
        if (state.status !== "running") { response.writeHead(409).end("Browser is inactive while the swarm is paused or finished"); return; }
        const descriptor = await load(join(path, "browser", "service.json")) as { port?: number; token?: string } | undefined;
        if (!descriptor || !Number.isInteger(descriptor.port) || descriptor.port! < 1 || descriptor.port! > 65535 || !/^[a-f0-9]{64}$/.test(descriptor.token ?? "")) { response.writeHead(404).end("This agent has not started a browser"); return; }
        try {
          const frame = await fetch(`http://127.0.0.1:${descriptor.port}/?worker=${encodeURIComponent(worker)}`, { headers: { Authorization: `Bearer ${descriptor.token}` }, signal: AbortSignal.timeout(6000), redirect: "error" });
          if (!frame.ok || frame.headers.get("content-type") !== "image/png") { response.writeHead(frame.ok ? 503 : frame.status).end("No active browser frame"); return; }
          response.setHeader("Content-Type", "image/png"); response.end(Buffer.from(await frame.arrayBuffer()));
        } catch { response.writeHead(503).end("Browser companion is unavailable"); }
        return;
      }
      const files: Record<string, [string, string]> = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"] };
      for (const font of ["IBMPlexMono-Regular.ttf", "IBMPlexMono-Medium.ttf", "BarlowCondensed-SemiBold.ttf"]) files[`/fonts/${font}`] = [`fonts/${font}`, "font/ttf"];
      const file = files[url.pathname]; if (!file) { response.writeHead(404).end("Not found"); return; }
      response.setHeader("Content-Type", `${file[1]}; charset=utf-8`); response.end(await readFile(join(assets, file[0])));
    } catch { response.writeHead(500).end("Unable to read swarm data. Check the configured state directory."); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address(); return { server, url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : options.port}` };
}

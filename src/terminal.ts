import { createInterface, type Interface } from "node:readline";
import type { Engine } from "./engine.js";
import type { Store } from "./store.js";
import type { RunEvent } from "./types.js";

/** Agent output is untrusted terminal text. Strip control sequences before display. */
export function plain(text: string): string {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
export function describe(store: Store): string {
  const state = store.state;
  return [
    `perf-SWARM · ${state.id} · ${state.status}`,
    `Objective: ${state.objective}`,
    ...state.workers.map((worker) => `${worker.name ?? worker.id} (${worker.id})  ${worker.stallSince ? "stalled" : worker.waiting ? "waiting" : worker.status === "tapped_out" ? "tapped out" : worker.parked ? "sleeping" : worker.status}  helpers ${state.children.filter((child) => child.parent === worker.id && ["pending", "running", "cancelling"].includes(child.status)).length}/4`),
    `Tasks: ${state.tasks.filter((task) => task.status === "done").length}/${state.tasks.length} done · tapouts ${Object.keys(state.tapouts).length}/${state.workers.length} · outcome ${state.outcome?.status ?? "pending"}`,
    `Tokens: ${state.tokens}${state.config.maxTokens ? `/${state.config.maxTokens}` : ""} · active time ${(state.elapsedMs / 1000).toFixed(1)}s`,
    `Phase: ${state.phase ?? "implementation"} · generation ${state.frozenGeneration ?? state.artifactGeneration ?? 0}${state.frozenGeneration !== undefined ? " frozen" : ""}`,
    `Outputs: ${state.artifacts?.find(item => item.number === state.frozenGeneration)?.snapshot ?? state.integration}`,
    state.pauseReason ? `Paused: ${state.pauseReason}` : "",
  ].filter(Boolean).join("\n");
}
const HELP = `/status                 Workers, tapouts, usage, outputs
/board                  Read the shared board
/post MESSAGE           Post to all workers (plain text does this too)
/dm NAME_OR_ID MESSAGE  Direct message a worker
/dms [NAME_OR_ID]       Read DMs (you can inspect all worker DMs)
/tasks                  Read task ownership and results
/tapouts                  Read worker tap-outs
/pause                  Pause and save the run
/help                   Show commands
Ctrl+C                  Pause and save`;

export class Terminal {
  private input?: Interface;
  private onEvent: (event: RunEvent) => void;
  constructor(readonly engine: Engine, readonly json = false, readonly interactive = process.stdin.isTTY) {
    this.onEvent = (event) => {
      const line = this.json ? JSON.stringify(event) : `[${event.at.slice(11, 19)}] ${event.actor ?? "system"} · ${event.type}: ${plain(event.message)}`;
      if (this.input && process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
      process.stdout.write(line + "\n");
      this.input?.prompt(true);
    };
  }
  start(): void {
    this.engine.store.on("event", this.onEvent);
    if (!this.json) process.stdout.write(plain(describe(this.engine.store)) + "\n");
    if (!this.interactive || this.json) return;
    this.input = createInterface({ input: process.stdin, output: process.stdout, prompt: "swarm> ", terminal: process.stdout.isTTY });
    process.stdout.write(HELP + "\n");
    this.input.on("line", (line) => {
      try { this.command(line.trim()); } catch (error) { process.stdout.write(`Error: ${plain(error instanceof Error ? error.message : String(error))}\n`); }
      this.input?.prompt();
    });
    this.input.on("SIGINT", () => { void this.engine.pause(); });
    this.input.on("close", () => { if (this.engine.store.state.status === "running") void this.engine.pause("Terminal input closed."); });
    this.input.prompt();
  }
  private command(line: string): void {
    if (!line) return;
    const store = this.engine.store;
    const [command = "", ...parts] = line.split(/\s+/);
    const body = parts.join(" ");
    if (!line.startsWith("/")) { store.post("user", line); this.engine.wakeAll(); return; }
    switch (command) {
      case "/help": process.stdout.write(HELP + "\n"); break;
      case "/status": process.stdout.write(plain(describe(store)) + "\n"); break;
      case "/board": process.stdout.write(plain(JSON.stringify(store.state.board, null, 2)) + "\n"); break;
      case "/tasks": process.stdout.write(plain(JSON.stringify(store.state.tasks, null, 2)) + "\n"); break;
      case "/tapouts": process.stdout.write(plain(JSON.stringify(store.state.tapouts, null, 2)) + "\n"); break;
      case "/dms": process.stdout.write(plain(JSON.stringify(store.state.dms.filter((dm) => !body || dm.author === (["user", "system"].includes(body) ? body : store.worker(body).id) || dm.to === (["user", "system"].includes(body) ? body : store.worker(body).id)), null, 2)) + "\n"); break;
      case "/post": store.post("user", body); this.engine.wakeAll(); break;
      case "/dm": {
        const to = parts.shift() ?? "";
        const dm = store.dm("user", to, parts.join(" ")); this.engine.wake(dm.to, true); break;
      }
      case "/pause": void this.engine.pause(); break;
      default: throw new Error(`Unknown command: ${command}. Use /help.`);
    }
  }
  close(): void { this.engine.store.off("event", this.onEvent); this.input?.close(); }
}

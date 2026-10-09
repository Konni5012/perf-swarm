import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

export interface RpcMessage { id?: number | string; method?: string; params?: any; result?: any; error?: { message: string; code?: number } }
/** Local stdio app-server transport. Never silently approve a server request. */
export class AppServer extends EventEmitter {
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private child: ChildProcessWithoutNullStreams;
  private closed = false;
  private stderr = "";
  constructor(binary = process.env.PERF_SWARM_CODEX_BIN ?? "codex", args = ["app-server", "--listen", "stdio://"], cwd?: string) {
    super();
    this.setMaxListeners(0); // One routing listener per live worker/helper thread.
    this.child = spawn(binary, args, { cwd, stdio: "pipe" });
    this.child.stderr.on("data", (data) => { this.stderr = (this.stderr + String(data)).slice(-4000); });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try { this.receive(JSON.parse(line)); } catch { this.fail(new Error("Codex app-server emitted invalid JSON.")); this.child.kill(); }
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) => this.fail(new Error(`Codex app-server exited (${code}): ${this.stderr.trim()}`)));
  }
  private receive(message: RpcMessage): void {
    if (message.method) { this.emit(message.id === undefined ? "notification" : "request", message); return; }
    const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    this.pending.delete(message.id as number); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
  }
  private send(message: RpcMessage): void {
    if (this.closed) throw new Error("Codex app-server is closed.");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id: number | string, result: unknown): void { this.send({ id, result }); }
  reject(id: number | string, message: string): void { this.send({ id, error: { code: -32601, message } }); }
  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "perf_swarm", title: "perf-SWARM", version: "2.0.0" }, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized", params: {} });
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit("closed", error);
  }
  dispose(): void { this.fail(new Error("Codex app-server stopped.")); this.child.kill(); }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const exec = promisify(execFile);
const image = "perf-swarm-chrome:1";
export type DockerCommand = (args: string[], timeout?: number) => Promise<string>;
const docker: DockerCommand = async (args, timeout = 120_000) => (await exec("docker", args, { timeout, maxBuffer: 1024 * 1024 })).stdout.trim();
interface Desktop { name: string; browser: Browser; context: BrowserContext; heartbeat: ReturnType<typeof setInterval> }

/** One ordinary headed Chrome/Xvfb container per agent; no host desktop access. */
export class VirtualChrome {
  private desktops = new Map<string, Desktop>();
  private starting = new Map<string, Promise<Desktop>>();
  private closed = false;
  constructor(readonly directory: string, private readonly command: DockerCommand = docker,
    private readonly connect = (url: string) => chromium.connectOverCDP(url, { timeout: 30_000 })) {}
  static async installed(command: DockerCommand = docker): Promise<boolean> {
    try { if ((await command(["info", "--format", "{{.OSType}}"])).trim() !== "linux") return false; await command(["image", "inspect", image]); return true; } catch { return false; }
  }
  private async desktop(worker: string): Promise<Desktop> {
    if (this.closed) throw new Error("Virtual Chrome has stopped.");
    const existing = this.desktops.get(worker); if (existing) return existing;
    let pending = this.starting.get(worker);
    if (!pending) { pending = this.start(worker).finally(() => this.starting.delete(worker)); this.starting.set(worker, pending); }
    return pending;
  }
  private async start(worker: string): Promise<Desktop> {
    const key = createHash("sha256").update(worker).digest("hex");
    const profile = join(this.directory, key, "profile"), lease = join(this.directory, key, "lease");
    await mkdir(profile, { recursive: true, mode: 0o700 }); await mkdir(lease, { recursive: true, mode: 0o700 });
    const file = join(lease, "heartbeat"); await writeFile(file, "owned by swarm\n", { mode: 0o600 });
    const heartbeat = setInterval(() => { const now = new Date(); void utimes(file, now, now).catch(() => {}); }, 2000); heartbeat.unref();
    const name = `perf-swarm-chrome-${randomUUID()}`;
    let browser: Browser | undefined;
    try {
      // No docker socket, host network, X socket, user browser directory, or workspace mount.
      await this.command(["run", "--detach", "--rm", "--name", name, "--platform", "linux/amd64", "--init",
        "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=256", "--memory=2g", "--cpus=2", "--shm-size=512m",
        "--publish", "127.0.0.1::9223", "--mount", `type=bind,src=${profile},dst=/profile`,
        "--mount", `type=bind,src=${lease},dst=/lease,readonly`, image]);
      const binding = await this.command(["port", name, "9223/tcp"]);
      const port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1];
      if (!port || Number(port) > 65535) throw new Error("Chrome endpoint was not bound exclusively to host loopback");
      const endpoint = `http://127.0.0.1:${port}`;
      let attached = false;
      for (let i = 0; i < 120; i++) {
        try {
          const response = await fetch(endpoint + "/json/version", { headers: { Host: "localhost" }, signal: AbortSignal.timeout(1000) });
          if (response.ok) { attached = true; break; }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!attached) throw new Error("Virtual Chrome did not start within 60 seconds");
      // Supplying the WS URL avoids Chrome's localhost discovery URL referring to the container port.
      const version = await (await fetch(endpoint + "/json/version", { headers: { Host: "localhost" }, signal: AbortSignal.timeout(3000) })).json() as { webSocketDebuggerUrl: string };
      const path = new URL(version.webSocketDebuggerUrl).pathname;
      browser = await this.connect(`ws://127.0.0.1:${port}${path}`);
      const context = browser.contexts()[0]; if (!context) throw new Error("Chrome has no persistent profile context");
      // Popups stay in the VM; unsolicited pages are closed, explicit tabs remain owned.
      context.on("page", page => { void page.opener().then(opener => { if (opener) return page.close(); }).catch(() => {}); });
      await context.clearPermissions();
      const desktop = { name, browser, context, heartbeat }; this.desktops.set(worker, desktop); return desktop;
    } catch (error) {
      clearInterval(heartbeat); await browser?.close().catch(() => {}); await this.command(["rm", "--force", name]).catch(() => {}); throw error;
    }
  }
  async page(worker: string): Promise<Page> {
    const { context } = await this.desktop(worker); const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    page.on("dialog", dialog => { void dialog.dismiss().catch(() => {}); });
    page.on("filechooser", chooser => { void chooser.setFiles([]).catch(() => {}); });
    return page;
  }
  get running() { return this.desktops.size > 0; }
  async close(worker?: string) {
    if (!worker) this.closed = true;
    await Promise.allSettled(worker ? [this.starting.get(worker)] : [...this.starting.values()]);
    const entries = [...this.desktops].filter(([id]) => !worker || worker === id);
    for (const [id, desktop] of entries) {
      clearInterval(desktop.heartbeat);
      // Closing a CDP-connected Playwright Browser only detaches its transport.
      // Ask Chrome itself to quit so persistent cookies/profile state are flushed.
      let graceful = false;
      try {
        const session = await desktop.browser.newBrowserCDPSession();
        await session.send("Browser.close"); graceful = true;
      } catch {}
      await desktop.browser.close().catch(() => {});
      let exited = false;
      if (graceful) {
        try { await this.command(["wait", desktop.name], 15_000); exited = true; }
        catch (error) { exited = /No such container/i.test(String(error)); }
      }
      if (!exited) await this.command(["stop", "--time", "10", desktop.name]).catch(async error => {
        if (/No such container/i.test(String(error))) return;
        await this.command(["rm", "--force", desktop.name]).catch(error => {
          if (!/No such container/i.test(String(error))) throw error;
        });
      });
      this.desktops.delete(id);
    }
  }
}

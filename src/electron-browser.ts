import { _electron, type ElectronApplication, type Page } from "playwright";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const hostEntry = join(dirname(fileURLToPath(import.meta.url)), "browser-host", "main.cjs");

/** One lazy companion per run, with owned offscreen windows and a profile per worker. */
export class ElectronBrowser {
  private application?: ElectronApplication;
  private launching?: Promise<ElectronApplication>;
  private closing = false;
  private pages = new Map<string, Page>();
  constructor(readonly profileDirectory: string) {}
  static async installed(): Promise<boolean> {
    try { await access(require("electron") as string); await access(hostEntry); return true; } catch { return false; }
  }
  get running(): boolean { return this.application !== undefined; }
  private async app(): Promise<ElectronApplication> {
    if (this.closing) throw new Error("Browser companion is stopping.");
    if (this.application) return this.application;
    this.launching ??= (async () => {
      await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== "ELECTRON_RUN_AS_NODE")) as Record<string, string>;
      const app = await _electron.launch({ executablePath: require("electron") as string, args: [hostEntry, this.profileDirectory, String(process.pid)], env, timeout: 30_000 });
      this.application = app;
      app.on("close", () => { this.application = undefined; this.pages.clear(); });
      return app;
    })().finally(() => { this.launching = undefined; });
    return this.launching;
  }
  private key(worker: string, tab: string): string { return `${worker}/${tab}`; }
  async page(worker: string, tab = "main"): Promise<Page> {
    const key = this.key(worker, tab), existing = this.pages.get(key);
    if (existing && !existing.isClosed()) return existing;
    const app = await this.app();
    const partition = `persist:perf-swarm-${createHash("sha256").update(worker).digest("hex")}`;
    const id = await app.evaluate((_electron, input) => (globalThis as any).perfSwarmBrowserHost.create(input.key, input.partition), { key, partition });
    // Each guest is discovered through Electron's private automation connection.
    for (let attempt = 0; attempt < 100; attempt++) {
      for (const page of app.windows()) {
        const window = await app.browserWindow(page);
        const contentsId = await window.evaluate(w => w.webContents.id); await window.dispose();
        if (contentsId === id) {
          // Intercept native pickers and dismiss page dialogs before exposing the page.
          page.on("filechooser", chooser => { void chooser.setFiles([]).catch(() => {}); });
          page.on("dialog", dialog => { void dialog.dismiss().catch(() => {}); });
          this.pages.set(key, page); return page;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await app.evaluate((_e, key) => (globalThis as any).perfSwarmBrowserHost.close(key), key);
    throw new Error("Offscreen browser tab did not attach within 2.5 seconds.");
  }
  async resize(worker: string, tab: string, width: number, height: number): Promise<void> {
    await this.page(worker, tab);
    await this.application!.evaluate((_e, input) => (globalThis as any).perfSwarmBrowserHost.resize(input.key, input.width, input.height), { key: this.key(worker, tab), width, height });
  }
  async status() { return this.application ? this.application.evaluate(() => (globalThis as any).perfSwarmBrowserHost.status()) : { windows: [], dockVisible: false }; }
  async close(worker?: string, tab?: string): Promise<void> {
    if (worker) {
      for (const key of [...this.pages.keys()]) if (key.startsWith(worker + "/") && (!tab || key === this.key(worker, tab))) {
        if (this.application) await this.application.evaluate((_e, key) => (globalThis as any).perfSwarmBrowserHost.close(key), key);
        this.pages.delete(key);
      }
      return;
    }
    this.closing = true;
    if (this.launching) await this.launching.catch(() => {});
    const app = this.application; this.application = undefined;
    try { await app?.close(); } finally { this.pages.clear(); this.closing = false; }
  }
}

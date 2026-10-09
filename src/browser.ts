import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createServer, type Server } from "node:http";
import { access, readFile, realpath, stat, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, sep, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { ElectronBrowser } from "./electron-browser.js";
import { VirtualChrome } from "./virtual-chrome.js";

export type BrowserBackend = "electron" | "chromium" | "chrome";
export interface BrowserOptions { backend?: BrowserBackend; profileDirectory?: string }

/** SWARM-owned browser provider: one isolated persistent context per worker. */
export interface AccessFailure { origin: string; url: string; kind: string; attempts: number; status?: number; detail: string }
export class BrowserProvider {
  private electron?: ElectronBrowser;
  private chrome?: VirtualChrome;
  private creatingChrome?: Promise<VirtualChrome>;
  private creatingElectron?: Promise<ElectronBrowser>;
  private temporaryProfiles?: string;
  private viewer?: Server;
  private viewerToken = randomBytes(32).toString("hex");
  private activeTabs = new Map<string, string>();
  private closed = false;
  readonly backend: BrowserBackend;
  private failures: Map<string, AccessFailure>;
  private launch?: Promise<Browser>;
  private navigations = new Map<string, Promise<unknown>>();
  private previews = new Map<string, { root: string; server: Server; url: string }>();
  constructor(private readonly options: BrowserOptions = {}, failures: AccessFailure[] = [], private readonly onFailure?: (failure: AccessFailure) => void) { this.backend = options.backend ?? "electron"; this.failures = new Map(failures.map(f => [f.origin, f])); }
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    this.launch ??= chromium.launch({ headless: true }).then(browser => { this.browser = browser; return browser; }).finally(() => { this.launch = undefined; });
    return this.launch;
  }
  private browser?: Browser;
  private contexts = new Map<string, BrowserContext>();
  private pages = new Map<string, Page>();
  private crashedPages = new WeakSet<Page>();
  private previewRoutes = new WeakMap<Page, Set<string>>();
  private resourceProblems = new Map<string, { url: string; status?: number; error?: string }[]>();
  private pageRequests = new Map<string, Promise<Page>>();

  async ready(): Promise<boolean> {
    // Installation preflight is read-only: no window/process launches until actual use.
    if (this.backend === "electron") return ElectronBrowser.installed();
    if (this.backend === "chrome") return VirtualChrome.installed();
    try { await access(chromium.executablePath()); return true; } catch { return false; }
  }
  private tabKey(worker: string, tab: string): string { return `${worker}/${tab}`; }
  private async page(worker: string, tab = this.activeTabs.get(worker) ?? "main"): Promise<Page> {
    if (this.closed) throw new Error("Browser service has stopped.");
    const key = this.tabKey(worker, tab), existing = this.pages.get(key);
    if (existing && !existing.isClosed() && !this.crashedPages.has(existing)) return existing;
    if (existing && this.crashedPages.has(existing)) await this.closeTab(worker, tab);
    const pending = this.pageRequests.get(key); if (pending) return pending;
    const request = this.createPage(worker, tab).finally(() => this.pageRequests.delete(key)); this.pageRequests.set(key, request); return request;
  }
  private async createPage(worker: string, tab: string): Promise<Page> {
    let page: Page;
    if (this.backend === "electron") {
      this.creatingElectron ??= (async () => {
        const profiles = this.options.profileDirectory ?? (this.temporaryProfiles ??= await mkdtemp(join(tmpdir(), "perf-swarm-browser-")));
        return this.electron = new ElectronBrowser(profiles);
      })();
      const electron = await this.creatingElectron;
      page = await electron.page(worker, tab);
    } else if (this.backend === "chrome") {
      this.creatingChrome ??= (async () => {
        const profiles = this.options.profileDirectory ?? (this.temporaryProfiles ??= await mkdtemp(join(tmpdir(), "perf-swarm-browser-")));
        return this.chrome = new VirtualChrome(profiles);
      })();
      page = await (await this.creatingChrome).page(worker);
    } else {
      await this.ensureBrowser();
      let context = this.contexts.get(worker);
      if (!context) { context = await this.browser!.newContext({ viewport: { width: 1440, height: 900 } }); this.contexts.set(worker, context); }
      page = await context.newPage();
      page.on("filechooser", chooser => { void chooser.setFiles([]).catch(() => {}); });
      page.on("dialog", dialog => { void dialog.dismiss().catch(() => {}); });
    }
    this.pages.set(this.tabKey(worker, tab), page); this.activeTabs.set(worker, tab);
    page.on("crash", () => this.crashedPages.add(page));
    const problem = (url: string, status?: number, error?: string) => {
      const u = new URL(url), path = u.pathname.startsWith("/cdn-cgi/") ? "/cdn-cgi/…" : u.pathname.slice(0, 160);
      const list = this.resourceProblems.get(worker) ?? []; if (list.length < 30) list.push({ url: u.origin + path, status, error }); this.resourceProblems.set(worker, list);
    };
    page.on("response", r => { if (r.status() >= 400) problem(r.url(), r.status()); });
    page.on("requestfailed", r => problem(r.url(), undefined, r.failure()?.errorText));
    await this.startViewer();
    return page;
  }
  private async startViewer(): Promise<void> {
    if (this.viewer || !this.options.profileDirectory) return;
    const server = createServer(async (request, response) => {
      const host = request.headers.host ?? "";
      if (!/^127\.0\.0\.1:\d+$/.test(host) || request.headers.authorization !== `Bearer ${this.viewerToken}` || request.headers.origin) { response.writeHead(403).end(); return; }
      if (request.method !== "GET") { response.writeHead(405).end(); return; }
      response.setHeader("Cache-Control", "no-store");
      const url = new URL(request.url ?? "/", `http://${host}`), worker = url.searchParams.get("worker") ?? "";
      const tab = url.searchParams.get("tab") ?? this.activeTabs.get(worker) ?? "main";
      const page = this.pages.get(this.tabKey(worker, tab));
      // Viewing never launches the companion, creates tabs, navigates, or wakes an agent.
      if (!page || page.isClosed()) { response.writeHead(404).end("No active browser for this agent"); return; }
      try {
        response.setHeader("Content-Type", "image/png"); response.end(await page.screenshot({ type: "png", timeout: 5000 }));
      } catch { response.writeHead(503).end("Browser frame unavailable"); }
    });
    this.viewer = server;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Browser viewer failed to listen");
      const directory = resolve(this.options.profileDirectory!, ".."); await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, "service.json"), JSON.stringify({ port: address.port, token: this.viewerToken, pid: process.pid, backend: this.backend }), { mode: 0o600 });
    } catch (error) { server.close(); this.viewer = undefined; throw error; }
  }
  async tabs(worker: string) {
    return Promise.all([...this.pages].filter(([key, p]) => key.startsWith(worker + "/") && !p.isClosed()).map(async ([key, page]) => ({ id: key.slice(worker.length + 1), active: key === this.tabKey(worker, this.activeTabs.get(worker) ?? "main"), url: page.url(), title: await page.title() })));
  }
  async newTab(worker: string, url?: string) {
    const tab = randomUUID().slice(0, 8); await this.page(worker, tab);
    if (url) await this.navigate(worker, url);
    return { tab, tabs: await this.tabs(worker) };
  }
  async selectTab(worker: string, tab: string) {
    if (!this.pages.has(this.tabKey(worker, tab))) throw new Error("No such tab owned by this worker.");
    this.activeTabs.set(worker, tab); return this.tabs(worker);
  }
  async closeTab(worker: string, tab: string) {
    const key = this.tabKey(worker, tab), page = this.pages.get(key);
    if (!page) throw new Error("No such tab owned by this worker.");
    if (this.electron) await this.electron.close(worker, tab); else await page.close().catch(() => {});
    this.pages.delete(key);
    if (this.activeTabs.get(worker) === tab) { const remaining = await this.tabs(worker); this.activeTabs.set(worker, remaining[0]?.id ?? "main"); }
    return this.tabs(worker);
  }
  async status() { return { backend: this.backend, running: Boolean(this.browser || this.electron?.running || this.chrome?.running), ...(this.electron ? await this.electron.status() : { windows: [], dockVisible: false }) }; }

  private failure(url: string, kind: string, detail: string, status?: number) {
    const origin = new URL(url).origin, prior = this.failures.get(origin);
    const item = { origin, url, kind, detail, status, attempts: prior?.kind === kind ? prior.attempts + 1 : 1 };
    this.failures.set(origin, item); this.onFailure?.(item); return item;
  }
  async navigate(worker: string, url: string) {
    const origin = new URL(url).origin;
    const operation = (this.navigations.get(origin) ?? Promise.resolve()).catch(() => {}).then(() => this.navigateSerial(worker, url));
    this.navigations.set(origin, operation);
    try { return await operation; } finally { if (this.navigations.get(origin) === operation) this.navigations.delete(origin); }
  }
  private async navigateSerial(worker: string, url: string) {
    if (!/^https?:\/\//i.test(url)) throw new Error("Browser navigation requires an http(s) URL.");
    const origin = new URL(url).origin, localPreview = [...this.previews.values()].some(p => new URL(p.url).origin === origin), prior = localPreview ? undefined : this.failures.get(origin);
    if (prior && prior.attempts >= 2) return { worker, accessible: false, skipped: true, blocker: prior, instruction: "Shared access blocker: two identical failures. Stop retries for this origin until the operator resets access after conditions change." };
    const page = await this.page(worker);
    this.resourceProblems.set(worker, []);
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      const text = (await page.locator("body").innerText({ timeout: 5000 })).slice(0, 8000);
      const status = response?.status(), title = await page.title();
      const challenge = /just a moment|checking (your )?browser|verify you are human|performing security verification|enable javascript and cookies to continue|attention required.*cloudflare/i.test(title + "\n" + text);
      const loadError = /this page couldn.{1,6}t load|application error:|a client-side exception has occurred/i.test(text);
      const resources = this.resourceProblems.get(worker) ?? [];
      const accessible = !challenge && !loadError && status !== undefined && status < 400;
      if (!accessible && localPreview) return { worker, url: page.url(), title, status, accessible, challenge, loadError, resources, text: text.slice(0, 2000), localPreview: true, instruction: "Local preview failed. Check the requested path and artifact files; retry after correcting them. This is not a shared reference-access blocker." };
      if (!accessible) return { worker, url: page.url(), title, status, accessible, challenge, loadError, resources, text: text.slice(0, 2000), blocker: this.failure(url, challenge ? "challenge" : loadError ? "application-load-error" : `http-${status ?? "unknown"}`, text.slice(0, 1000), status) };
      if (!localPreview) { this.failures.delete(origin); this.onFailure?.({ origin, url, attempts: 0, kind: "accessible", status, detail: "Access recovered" }); }
      return { worker, url: page.url(), title, status, accessible, challenge, loadError, resources, text: text.slice(0, 2000) };
    } catch (error) {
      const detail = String(error).slice(0, 1000);
      if (localPreview || /crashed|browser.*closed|target.*closed/i.test(detail)) return { worker, url, accessible: false, localPreview, runtimeError: detail, instruction: "Browser runtime or local preview failed, not reference access. A crashed tab will be recreated on the next browser call; check the local artifact path if applicable." };
      return { worker, url, accessible: false, blocker: this.failure(url, error instanceof Error && error.name === "TimeoutError" ? "timeout" : "navigation-error", String(error).slice(0, 1000)) };
    }
  }
  async viewport(worker: string, width: number, height: number) {
    if (![width, height].every(n => Number.isInteger(n) && n >= 240 && n <= 4096)) throw new Error("Viewport dimensions must be integers from 240 to 4096.");
    if (this.backend === "electron") await this.electronResize(worker, width, height); else await (await this.page(worker)).setViewportSize({ width, height }); return { worker, width, height };
  }
  private async electronResize(worker: string, width: number, height: number) { await this.page(worker); await this.electron!.resize(worker, this.activeTabs.get(worker) ?? "main", width, height); }
  async type(worker: string, text: string, selector?: string) {
    const page = await this.page(worker);
    if (selector) await page.locator(selector).first().fill(text); else await page.keyboard.insertText(text);
    return { worker, url: page.url() };
  }
  async press(worker: string, key: string) { await (await this.page(worker)).keyboard.press(key); return { worker, key }; }
  async scroll(worker: string, x: number, y: number) { await (await this.page(worker)).mouse.wheel(x, y); return { worker }; }
  async clickAt(worker: string, x: number, y: number) { await (await this.page(worker)).mouse.click(x, y); return { worker }; }
  /** Host serves only the worker's authorized workspace/frozen snapshot; no shell bind escalation. */
  async preview(worker: string, directory: string, entry?: string) {
    const root = await realpath(directory), prior = this.previews.get(worker);
    let path = "/";
    if (entry) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(entry) && !entry.startsWith("file:")) throw new Error("Preview requires a local artifact path, not a network URL");
      const target = await realpath(entry.startsWith("file:") ? fileURLToPath(entry) : resolve(root, entry));
      if (target !== root && !target.startsWith(root + sep)) throw new Error("Preview path is outside the authorized workspace");
      path = "/" + target.slice(root.length + 1).split(sep).map(encodeURIComponent).join("/");
      if ((await stat(target)).isDirectory() && !path.endsWith("/")) path += "/";
    }
    if (prior?.root === root) return this.previewNavigate(worker, prior.url, path);
    if (prior) await new Promise<void>(resolve => prior.server.close(() => resolve()));
    const server = createServer(async (request, response) => {
      response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
      try {
        if (!["GET", "HEAD"].includes(request.method ?? "")) { response.writeHead(405).end(); return; }
        const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
        let file = await realpath(resolve(root, "." + pathname));
        if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
        if ((await stat(file)).isDirectory()) file = await realpath(resolve(file, "index.html"));
        if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
        const type: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
        response.setHeader("Content-Type", type[extname(file)] ?? "application/octet-stream");
        const bytes = await readFile(file); response.end(request.method === "HEAD" ? undefined : bytes);
      } catch { response.writeHead(404).end("Not found"); }
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Preview listen failed");
    const url = `http://127.0.0.1:${address.port}/`; this.previews.set(worker, { root, server, url });
    return this.previewNavigate(worker, url, path);
  }
  private async previewNavigate(worker: string, url: string, path: string) {
    if (this.backend === "chrome") {
      // The virtual desktop cannot reach host loopback. Forward only this scoped
      // static preview through the existing private automation connection.
      const page = await this.page(worker);
      const routes = this.previewRoutes.get(page) ?? new Set<string>();
      this.previewRoutes.set(page, routes);
      if (!routes.has(url)) {
        routes.add(url);
        try {
          await page.route(url + "**", async route => {
            try {
              const response = await fetch(route.request().url(), { method: route.request().method(), redirect: "error", signal: AbortSignal.timeout(5000) });
              if (page.isClosed() || this.crashedPages.has(page)) return;
              await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
            } catch {
              if (!page.isClosed() && !this.crashedPages.has(page)) await route.abort().catch(() => {});
            }
          });
        } catch (error) { routes.delete(url); throw error; }
      }
    }
    return this.navigate(worker, new URL(path, url).href);
  }

  async snapshot(worker: string) {
    const page = await this.page(worker);
    const elements = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("a,button,input,textarea,select,[role=button],[contenteditable=true]")).filter(el => el.getClientRects().length).slice(0, 100).map(el => {
      const rect = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), label: (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.innerText || "").slice(0, 120), selector: el.id ? `#${CSS.escape(el.id)}` : undefined, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    }));
    return { worker, tab: this.activeTabs.get(worker) ?? "main", url: page.url(), title: await page.title(), text: (await page.locator("body").innerText()).slice(0, 40_000), elements };
  }

  async click(worker: string, selector: string) {
    const page = await this.page(worker);
    await page.locator(selector).first().click({ timeout: 10_000 });
    return { worker, url: page.url(), title: await page.title() };
  }

  async screenshot(worker: string) {
    const page = await this.page(worker);
    const bytes = await page.screenshot({ type: "png" });
    return { worker, url: page.url(), screenshotBase64: bytes.toString("base64") };
  }

  async close(worker?: string) {
    if (worker) {
      const preview = this.previews.get(worker); if (preview) await new Promise<void>(resolve => preview.server.close(() => resolve())); this.previews.delete(worker);
      if (this.electron) await this.electron.close(worker); else if (this.chrome) await this.chrome.close(worker); else await this.contexts.get(worker)?.close();
      this.contexts.delete(worker); for (const key of this.pages.keys()) if (key.startsWith(worker + "/")) this.pages.delete(key); this.activeTabs.delete(worker); return;
    }
    this.closed = true;
    await Promise.allSettled([...this.pageRequests.values()]);
    if (this.launch) await this.launch.catch(() => {});
    if (this.viewer) { this.viewer.closeAllConnections(); await new Promise<void>(resolve => this.viewer!.close(() => resolve())); this.viewer = undefined; }
    if (this.options.profileDirectory) await rm(resolve(this.options.profileDirectory, "..", "service.json"), { force: true });
    for (const preview of this.previews.values()) { preview.server.closeAllConnections(); await new Promise<void>(resolve => preview.server.close(() => resolve())); } this.previews.clear();
    await this.electron?.close(); this.electron = undefined;
    await this.chrome?.close(); this.chrome = undefined;
    await this.browser?.close(); this.browser = undefined; this.contexts.clear(); this.pages.clear(); this.activeTabs.clear();
    if (this.temporaryProfiles) await rm(this.temporaryProfiles, { recursive: true, force: true });
  }
}

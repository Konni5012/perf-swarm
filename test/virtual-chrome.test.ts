import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualChrome } from "../src/virtual-chrome.js";
import { BrowserProvider } from "../src/browser.js";

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "perf-swarm-chrome-test-"));
  const server = createServer((_req, res) => res.setHeader("Content-Type", "application/json").end(JSON.stringify({ webSocketDebuggerUrl: "ws://localhost:9222/devtools/browser/test" })));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const commands: string[][] = [], connections: string[] = [];
  const command = async (args: string[]) => { commands.push(args); return args[0] === "port" ? `127.0.0.1:${port}` : "ok"; };
  const connect = async (url: string) => {
    connections.push(url);
    const context = { newPage: async () => ({ on() {}, setViewportSize: async () => {} }), on() {}, clearPermissions: async () => {} };
    return { contexts: () => [context], newBrowserCDPSession: async () => ({ send: async (method: string) => { assert.equal(method, "Browser.close"); } }), close: async () => {} } as any;
  };
  const browser = new VirtualChrome(directory, command, connect);
  return { directory, browser, commands, connections, command, connect, cleanup: async () => { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); } };
}
test("virtual Chrome creates one bounded desktop/profile per worker and cleans containers while retaining profiles", async () => {
  const h = await harness();
  try {
    await Promise.all([h.browser.page("one"), h.browser.page("one"), h.browser.page("two")]);
    const runs = h.commands.filter(a => a[0] === "run");
    assert.equal(runs.length, 2); assert.notEqual(runs[0]![runs[0]!.indexOf("--name") + 1], runs[1]![runs[1]!.indexOf("--name") + 1]);
    const profiles = runs.map(a => a.find(v => v.endsWith("dst=/profile"))!);
    assert.notEqual(profiles[0], profiles[1]);
    for (const run of runs) {
      assert.ok(run.includes("127.0.0.1::9223")); assert.ok(run.includes("--cap-drop=ALL"));
      assert.ok(run.includes("--security-opt=no-new-privileges"));
      assert.equal(run.filter(v => v.startsWith("type=bind")).length, 2);
      assert.ok(!run.some(v => /docker.sock|X11-unix|network=host|privileged/.test(v)));
    }
    assert.ok(h.connections.every(url => /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/test$/.test(url)));
    await h.browser.close("one"); assert.equal(h.browser.running, true);
    await h.browser.close(); assert.equal(h.browser.running, false);
    assert.equal(h.commands.filter(a => a[0] === "wait").length, 2);
    for (const mount of profiles) await stat(mount.match(/src=(.*),dst=/)![1]!);
    await assert.rejects(h.browser.page("three"), /stopped/);
  } finally { await h.cleanup(); }
});
test("failed virtual desktop attachment removes its container and permits retry", async () => {
  const h = await harness();
  const browser = new VirtualChrome(h.directory, h.command, async () => { throw new Error("attachment failed"); });
  try {
    await assert.rejects(browser.page("one"), /attachment failed/);
    assert.equal(h.commands.filter(a => a[0] === "rm").length, 1);
    await assert.rejects(browser.page("one"), /attachment failed/);
    assert.equal(h.commands.filter(a => a[0] === "run").length, 2);
  } finally { await browser.close(); await h.cleanup(); }
});
test("virtual Chrome preflight checks Docker and image without launching or pulling", async () => {
  const commands: string[][] = [];
  assert.equal(await VirtualChrome.installed(async args => { commands.push(args); return "linux"; }), true);
  assert.deepEqual(commands.map(a => a[0]), ["info", "image"]);
  assert.equal(await VirtualChrome.installed(async () => { throw new Error("Docker absent"); }), false);
  assert.equal(await VirtualChrome.installed(async () => "windows"), false);
});
test("virtual desktop entry uses headed stable Chrome, private X display and owner heartbeat", async () => {
  const script = await readFile(new URL("../src/virtual-chrome/start.sh", import.meta.url), "utf8");
  assert.match(script, /Xvfb :99/); assert.match(script, /google-chrome-stable/);
  assert.doesNotMatch(script, /--headless/); assert.match(script, /\/lease\/heartbeat/);
});
test("real virtual Chrome renders isolated previews, tabs and retains profile directories", { skip: process.env.SWARM_TEST_VIRTUAL_CHROME !== "1", timeout: 240_000 }, async () => {
  assert.equal(await VirtualChrome.installed(), true, "Build perf-swarm-chrome:1 with Docker running first");
  const directory = await mkdtemp(join(tmpdir(), "swarm-real-chrome-"));
  const profileDirectory = join(directory, "browser", "profiles"), workspace = join(directory, "web");
  const { mkdir } = await import("node:fs/promises"); await mkdir(join(workspace, "demo"), { recursive: true });
  await writeFile(join(workspace, "demo", "index.html"), '<body><input id="text"><p id="value"></p><canvas id="c"></canvas><script>document.querySelector("p").textContent=document.cookie;document.querySelector("input").oninput=e=>{document.cookie="value="+e.target.value+";max-age=3600;path=/";document.querySelector("p").textContent=e.target.value};let n=0;function frame(){document.querySelector("canvas").getContext("2d").fillRect(n++%100,10,2,2);requestAnimationFrame(frame)}frame()</script>');
  let browser = new BrowserProvider({ backend: "chrome", profileDirectory });
  try {
    assert.equal((await browser.preview("one", workspace, "demo/index.html")).accessible, true);
    for (let i = 0; i < 4; i++) assert.equal((await browser.preview("one", workspace, "demo/index.html")).accessible, true);
    const page = await (browser as any).page("one");
    const session = await page.context().newCDPSession(page);
    const crashed = page.waitForEvent("crash", { timeout: 10_000 });
    void session.send("Page.crash").catch(() => {});
    await crashed;
    assert.equal((await browser.preview("one", workspace, "demo/index.html")).accessible, true);
    await browser.type("one", "isolated", "#text");
    assert.match((await browser.snapshot("one")).text, /isolated/);
    assert.ok((await browser.screenshot("one")).screenshotBase64.length > 100);
    await browser.viewport("one", 390, 844);
    assert.equal((await browser.preview("two", workspace, "demo/index.html")).accessible, true);
    assert.doesNotMatch((await browser.snapshot("two")).text, /isolated/);
    assert.equal((await browser.tabs("one")).length, 1);
    await browser.newTab("one"); await browser.preview("one", workspace, "demo/index.html");
    assert.equal((await browser.tabs("one")).length, 2);
    await browser.close();
    browser = new BrowserProvider({ backend: "chrome", profileDirectory });
    assert.equal((await browser.preview("one", workspace, "demo/index.html")).accessible, true);
    assert.match((await browser.snapshot("one")).text, /value=isolated/);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

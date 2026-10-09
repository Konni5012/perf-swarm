import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { BrowserProvider } from "../src/browser.js";
import { ElectronBrowser } from "../src/electron-browser.js";
import { fixture } from "./helpers.js";
import { Engine } from "../src/engine.js";
import { startDashboard } from "../src/dashboard.js";

const html = `<!doctype html><meta charset="utf-8"><title>Offscreen fixture</title><body>
<input id="file" type="file"><input id="entry"><button id="submit" onclick="out.textContent=entry.value">Submit</button><p id="out">waiting</p>
<canvas id="canvas" width="150" height="100"></canvas><p id="frames"></p><p id="graphics"></p>
<script>
let n=0; const ctx=canvas.getContext('2d'); function frame(){n++;ctx.fillStyle=n%2?'#f00':'#00f';ctx.fillRect(0,0,150,100);ctx.fillStyle='#fff';ctx.fillRect(n%140,0,10,100);document.getElementById('frames').textContent='frames:'+n;requestAnimationFrame(frame)}frame();
const gpu=document.createElement('canvas');gpu.width=16;gpu.height=16;document.body.appendChild(gpu);const gl=gpu.getContext('webgl');if(gl){gl.clearColor(0,0,1,1);gl.clear(gl.COLOR_BUFFER_BIT);const p=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);graphics.textContent='webgl:'+Array.from(p)+' node:'+typeof require;}
</script>`;

test("Electron remains hidden, isolates and persists profiles, renders animation/WebGL, and routes input", { timeout: 30000 }, async () => {
  const f = await fixture(2), profiles = join(f.directory, "browser", "profiles");
  await mkdir(profiles, { recursive: true });
  const host = createServer((_req, res) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html));
  await new Promise<void>(resolve => host.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
  let browser = new ElectronBrowser(profiles);
  try {
    assert.equal(browser.running, false);
    const [a,b] = await Promise.all([browser.page("worker-0001"), browser.page("worker-0002")]);
    await Promise.all([a.goto(url), b.goto(url)]);
    await a.evaluate(() => { localStorage.setItem("identity", "A"); document.cookie = "identity=A; path=/; max-age=3600"; });
    assert.equal(await b.evaluate(() => localStorage.getItem("identity")), null);
    assert.equal(await b.evaluate(() => document.cookie), "");
    await a.locator("#entry").fill("agent A"); await a.locator("#submit").click();
    assert.equal(await a.locator("#out").innerText(), "agent A");
    await b.locator("#entry").click(); await b.keyboard.insertText("agent B"); await b.keyboard.press("Tab"); await b.keyboard.press("Enter");
    assert.equal(await b.locator("#out").innerText(), "agent B");
    assert.equal(await a.locator("#entry").inputValue(), "agent A");
    const count = await a.locator("#frames").innerText(); await a.waitForTimeout(150);
    assert.notEqual(await a.locator("#frames").innerText(), count);
    assert.equal(await a.locator("#graphics").innerText(), "webgl:0,0,255,255 node:undefined");
    const screenshot = await a.screenshot(); assert.equal(screenshot.subarray(1,4).toString(), "PNG");
    await writeFile("/private/tmp/swarm-electron-verified.png", screenshot);
    const chooser = a.waitForEvent("filechooser"); await a.locator("#file").click(); await chooser;
    await a.waitForFunction(() => (document.getElementById("file") as HTMLInputElement).files?.length === 0);
    await a.evaluate(() => setTimeout(() => alert("Do not show a native dialog"), 0));
    await a.locator("#entry").fill("Still responsive");
    const popup = a.waitForEvent("popup", { timeout: 400 }).catch(() => null);
    await a.evaluate(() => window.open("https://example.com")); assert.equal(await popup, null);
    const status = await browser.status();
    assert.equal(status.windows.length, 2); assert.equal(status.dockVisible, false);
    assert.ok(status.windows.every((w: any) => !w.visible && !w.focused && w.offscreen && !w.backgroundThrottling));
    await browser.close(); assert.equal(browser.running, false);
    browser = new ElectronBrowser(profiles);
    const resumed = await browser.page("worker-0001"); await resumed.goto(url);
    assert.equal(await resumed.evaluate(() => localStorage.getItem("identity")), "A");
    assert.match(await resumed.evaluate(() => document.cookie), /identity=A/);
  } finally { await browser.close(); host.closeAllConnections(); await new Promise<void>(resolve => host.close(() => resolve())); await f.cleanup(); }
});

test("lazy companion, worker-owned tabs, authenticated passive dashboard frames, and cleanup", { timeout: 30000 }, async () => {
  const f = await fixture(2);
  const engine = new Engine(f.store, { create: async () => { throw new Error("No paid model calls"); } });
  const browser = engine.browser;
  const dashboard = await startDashboard({ stateDir: f.directory, port: 0 });
  try {
    assert.equal(await browser.ready(), true); assert.equal((await browser.status()).running, false);
    await assert.rejects(() => stat(join(f.directory, "browser", "service.json")), /ENOENT/);
    f.store.update(s => { s.status = "running"; });
    const frameUrl = dashboard.url + "/api/browser-frame?run=.&worker=worker-0001";
    assert.equal((await fetch(frameUrl)).status, 404); assert.equal((await browser.status()).running, false);
    await writeFile(join(f.store.worker("worker-0001").workspace, "index.html"), html);
    await browser.preview("worker-0001", f.store.worker("worker-0001").workspace);
    await browser.type("worker-0001", "hello", "#entry");
    const submit = (await browser.snapshot("worker-0001")).elements.find(e => e.selector === "#submit")!;
    await browser.clickAt("worker-0001", submit.x, submit.y);
    assert.match((await browser.snapshot("worker-0001")).text, /hello/);
    await browser.viewport("worker-0001", 375, 812);
    const screenshot = Buffer.from((await browser.screenshot("worker-0001")).screenshotBase64, "base64");
    assert.equal(screenshot.readUInt32BE(16), 375); assert.equal(screenshot.readUInt32BE(20), 812);
    const tab = await browser.newTab("worker-0001"); assert.equal((await browser.tabs("worker-0001")).length, 2);
    await assert.rejects(() => browser.selectTab("worker-0002", tab.tab), /owned/);
    await browser.selectTab("worker-0001", "main");
    const response = await fetch(frameUrl); assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/png");
    const descriptor = JSON.parse(await readFile(join(f.directory, "browser", "service.json"), "utf8"));
    assert.equal((await fetch(`http://127.0.0.1:${descriptor.port}/?worker=worker-0001`)).status, 403);
    assert.equal((await fetch(dashboard.url + "/api/browser-frame?run=.&worker=foreign")).status, 404);
    assert.equal((await fetch(frameUrl, { headers: { Origin: "https://untrusted.test" } })).status, 403);
    await engine.pause("Pause lifecycle test"); assert.equal((await fetch(frameUrl)).status, 409); assert.equal((await browser.status()).running, false);
    await assert.rejects(() => stat(join(f.directory, "browser", "service.json")), /ENOENT/);
    assert.ok((await stat(join(f.directory, "browser", "profiles"))).isDirectory());
    await assert.rejects(() => browser.snapshot("worker-0001"), /stopped/);
  } finally { await browser.close(); dashboard.server.closeAllConnections(); await new Promise<void>(resolve => dashboard.server.close(() => resolve())); await f.cleanup(); }
});

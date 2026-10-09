import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { BrowserProvider } from "../src/browser.js";
import { fixture } from "./helpers.js";
import { Engine } from "../src/engine.js";
import { workerTools } from "../src/tools.js";

async function server(handler: Parameters<typeof createServer>[0]) {
  const s = createServer(handler);
  await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => new Promise<void>(resolve => s.close(() => resolve())) };
}
test("shared challenge attempts are bounded even across concurrent workers and URL variants", async () => {
  let hits = 0;
  const host = await server((_req, res) => { if (_req.url?.startsWith('/ref')) hits++; res.writeHead(403, { "Content-Type": "text/html" }).end("<title>Just a moment...</title><body>Verify you are human</body>"); });
  const failures: unknown[] = [], browser = new BrowserProvider({ backend: "chromium" }, [], f => failures.push(f));
  try {
    const results = await Promise.all([1, 2, 3, 4].map(n => browser.navigate(`worker-${n}`, host.url + `/ref-${n}`)));
    assert.equal(hits, 2); assert.equal(failures.length, 2);
    assert.equal(results.filter(r => "skipped" in r && r.skipped).length, 2);
    assert.ok(results.every(r => r.accessible === false));
  } finally { await browser.close(); await host.close(); }
});
test("HTTP 200 with failed hydration is inaccessible and includes resource diagnostics", async () => {
  const host = await server((req, res) => {
    if (req.url === "/blocked.js") return void res.writeHead(403).end("denied");
    res.writeHead(200, { "Content-Type": "text/html" }).end('<title>Article</title><body>Article text<script src="/blocked.js"></script><script>setTimeout(()=>document.body.innerHTML="This page couldn’t load", 100)</script></body>');
  });
  const browser = new BrowserProvider({ backend: "chromium" });
  try {
    const result = await browser.navigate("worker", host.url);
    assert.equal(result.accessible, false); assert.equal(result.status, 200); assert.equal(result.blocker?.kind, "application-load-error");
    assert.ok(result.resources?.some(r => r.status === 403));
  } finally { await browser.close(); await host.close(); }
});
test("worker static preview is scoped, supports mobile dimensions, and screenshots are images", async () => {
  const f = await fixture(1);
  const engine = new Engine(f.store, { create: async () => { throw new Error("No model calls"); } });
  try {
    await writeFile(join(f.store.worker("worker-0001").workspace, "index.html"), "<title>Local artifact</title><body>hello</body>");
    await writeFile(join(f.directory, "outside.txt"), "secret");
    await symlink(join(f.directory, "outside.txt"), join(f.store.worker("worker-0001").workspace, "escape.txt"));
    f.store.update(s => { s.status = "running"; });
    const browser = workerTools(engine, "worker-0001").find(t => t.name === "browser")!;
    const preview = await browser.execute("p", { action: "preview" });
    const url = JSON.parse(preview.content[0]!.text).url;
    assert.equal((await fetch(url + "escape.txt")).status, 403);
    await browser.execute("v", { action: "viewport", width: 375, height: 812 });
    const screenshot = await browser.execute("s", { action: "screenshot" });
    assert.equal(screenshot.content[1]?.type, "image");
    assert.doesNotMatch(JSON.stringify(screenshot.content[0]), /screenshotBase64/);
    assert.match(screenshot.content[1]!.imageUrl, /^data:image\/png;base64,/);
    const png = Buffer.from(screenshot.content[1]!.imageUrl.split(",")[1]!, "base64");
    assert.equal(png.readUInt32BE(16), 375); assert.equal(png.readUInt32BE(20), 812);
    f.store.update(s => { s.config.webSearch = false; });
    assert.ok(!workerTools(engine, "worker-0001").some(t => t.name === "browser"));
  } finally { await engine.browser.close(); await f.cleanup(); }
});

test("local previews recover from repeated 404s and honor scoped nested entry paths", async () => {
  const f = await fixture(1);
  const root = f.store.worker("worker-0001").workspace;
  const failures: unknown[] = [], browser = new BrowserProvider({ backend: "chromium" }, [], f => failures.push(f));
  try {
    assert.equal((await browser.preview("one", root)).status, 404);
    assert.equal((await browser.preview("one", root)).status, 404);
    assert.deepEqual(failures, []);
    const { mkdir } = await import("node:fs/promises"); await mkdir(join(root, "demo"));
    await writeFile(join(root, "demo", "index.html"), '<title>Nested artifact</title><body>nested</body>');
    const nested = await browser.preview("one", root, "demo/index.html");
    assert.equal(nested.accessible, true); assert.match(nested.url!, /\/demo\/index.html$/);
    assert.equal((await browser.preview("one", root, join(root, "demo", "index.html"))).accessible, true);
    assert.equal((await browser.preview("one", root, new URL(`file://${join(root, "demo", "index.html")}`).href)).accessible, true);
    await writeFile(join(root, "index.html"), '<body>now ready</body>');
    assert.equal((await browser.preview("one", root)).accessible, true);
    await writeFile(join(f.directory, "outside.html"), 'outside');
    await symlink(join(f.directory, "outside.html"), join(root, "escape.html"));
    await assert.rejects(browser.preview("one", root, "escape.html"), /outside/);
    await assert.rejects(browser.preview("one", root, "../outside.html"), /outside/);
    await assert.rejects(browser.preview("one", root, "https://example.com/"), /local artifact/);
  } finally { await browser.close(); await f.cleanup(); }
});

test("renderer crashes recreate owned tabs without poisoning reference access", async () => {
  const host = await server((_req, res) => res.end('<body>healthy</body>'));
  const failures: unknown[] = [], browser = new BrowserProvider({ backend: "chromium" }, [], f => failures.push(f));
  try {
    await browser.navigate("one", host.url);
    const page = await (browser as any).page("one");
    const session = await page.context().newCDPSession(page);
    const crashed = page.waitForEvent("crash", { timeout: 5000 });
    void session.send("Page.crash").catch(() => {});
    await crashed;
    const recovered = await browser.navigate("one", host.url);
    assert.equal(recovered.accessible, true);
    assert.ok(!failures.some((f: any) => f.attempts > 0));
  } finally { await browser.close(); await host.close(); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computerUseConfig } from "../src/computer-use.js";
import { CodexDriver } from "../src/driver.js";
import { AppServer } from "../src/protocol.js";
import { config } from "./helpers.js";

test("CUA opt-in isolates roles, preserves sandbox and releases turn access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-cua-test-"));
  const manifest = join(dir, ".mcp.json");
  await writeFile(manifest, JSON.stringify({ mcpServers: {
    cua_repl: { command: process.execPath, args: ["runtime.mjs"], env: { EXAMPLE: "test" } },
    unrelated: { command: "unwanted" },
  } }));
  const server = new AppServer(process.execPath, [fileURLToPath(new URL("./mock-app-server.mjs", import.meta.url))]);
  try {
    await server.initialize();
    const driver = new CodexDriver(server, { ...config(1), computerUseManifest: manifest });
    assert.equal((await driver.preflight()).computerUse, "connected");
    await server.request("test/mcp-status", { connected: false });
    await assert.rejects(driver.preflight(), /preflight failed/);
    await server.request("test/mcp-status", { connected: true });
    const opts = { id: "worker-1234", model: "test-model", workspace: dir, system: "test", tools: [], onUsage: () => {} };
    const worker = await driver.create({ ...opts, computerUse: true });
    await worker.prompt("work");
    let state = await server.request("test/state", {});
    assert.deepEqual(state.lastStart.config["mcp_servers.cua_repl"].enabled_tools, ["js", "js_reset", "turn_ended"]);
    assert.equal(state.lastStart.config["mcp_servers.private_server.enabled"], false);
    assert.equal(state.lastStart.config["mcp_servers.unrelated"], undefined);
    assert.equal(state.lastStart.config["features.plugins"], false);
    assert.equal(state.lastStart.approvalsReviewer, "auto_review");
    assert.equal(state.lastTurn.sandboxPolicy.type, "workspaceWrite");
    assert.equal(state.computerCleanup.length, 1);
    assert.equal(state.computerCleanup[0].tool, "turn_ended");
    const pending = worker.prompt("hang");
    void pending.catch(() => {});
    for (let n = 0; n < 100; n++) {
      state = await server.request("test/state", {});
      if (state.lastTurn.input[0].text === "hang") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await worker.abort();
    await assert.rejects(pending, /interrupted/);
    state = await server.request("test/state", {});
    assert.equal(state.computerCleanup.length, 2);
    worker.dispose();
    for (const role of [{}, { computerUse: true, readOnly: true }]) {
      const agent = await driver.create({ ...opts, ...role });
      state = await server.request("test/state", {});
      assert.equal(state.lastStart.config["mcp_servers.cua_repl"], undefined);
      agent.dispose();
    }
    const disabled = new CodexDriver(server, { ...config(1), computerUseManifest: manifest, webSearch: false });
    await assert.rejects(disabled.create({ ...opts, computerUse: true }), /disabled/);
    await writeFile(manifest, JSON.stringify({ mcpServers: { cua_repl: { command: "relative", args: [] } } }));
    await assert.rejects(computerUseConfig(manifest), /absolute/);
  } finally { server.dispose(); await rm(dir, { recursive: true, force: true }); }
});

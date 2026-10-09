#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { access, readdir } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { connectCodex, CodexDriver, listModels, validateModels } from "./driver.js";
import { parseMix } from "./models.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { createRun } from "./run.js";
import { startDashboard } from "./dashboard.js";
import { describe, plain, Terminal } from "./terminal.js";
import type { RunConfig } from "./types.js";
import { computerUseConfig } from "./computer-use.js";
import { ExperimentStore } from "./experiments.js";

export function positiveInteger(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new InvalidArgumentError("Use a positive integer.");
  return Number(value);
}
export function duration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value);
  if (!match) throw new InvalidArgumentError("Use a duration such as 30s, 15m, or 2h (bare numbers are seconds).");
  const amount = Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] ?? "s"]!);
  if (!Number.isFinite(amount) || amount < 1 || amount > Number.MAX_SAFE_INTEGER) throw new InvalidArgumentError("Runtime limit must be a positive finite duration.");
  return amount;
}
function runPath(value: string, stateDirectory: string): string {
  return value.includes("/") || value.includes("\\") ? resolve(value) : resolve(stateDirectory, value);
}
async function execute(store: Store, json: boolean, interactive: boolean, budgets?: { runtime?: number; tokens?: number; resetBrowserAccess?: boolean; browserBackend?: "electron" | "chromium" | "chrome" }): Promise<void> {
  const release = await lockfile.lock(store.stateFile, { stale: 10000, retries: 0 });
  let engine: Engine | undefined;
  let server: Awaited<ReturnType<typeof connectCodex>> | undefined;
  let terminal: Terminal | undefined;
  const pause = () => { if (engine) void engine.pause("Interrupted by user."); };
  try {
    // Re-read only after acquiring the lock; another process may have updated this run.
    store = Store.open(store.directory);
    if (store.state.status === "completed") throw new Error("This run is already complete. Start a new swarm.");
    if (budgets) store.update((state) => {
      if (budgets.runtime !== undefined) { state.config.maxRuntimeMs = budgets.runtime; state.graceDeadlineElapsedMs = undefined; }
      if (budgets.tokens !== undefined) state.config.maxTokens = budgets.tokens;
      if (budgets.resetBrowserAccess) state.browserAccess = [];
      if (budgets.browserBackend) state.config.browserBackend = budgets.browserBackend;
    });
    for (const worker of store.state.workers) await access(worker.workspace);
    server = await connectCodex();
    await validateModels(server, [store.state.config.model, ...store.state.workers.map((worker) => worker.model), store.state.config.subagentModel]);
    const driver = new CodexDriver(server, store.state.config);
    const capabilities = await driver.preflight();
    store.update(state => { state.capabilities = capabilities; });
    engine = new Engine(store, driver);
    terminal = new Terminal(engine, json, interactive);
    process.on("SIGINT", pause); process.on("SIGTERM", pause);
    terminal.start();
    await engine.run();
    if (!json) process.stdout.write(plain(describe(store)) + (store.state.status === "paused" ? `\nResume: perf-swarm resume ${store.directory}\n` : "\n"));
    if (store.state.status === "paused") process.exitCode = 2;
  } finally {
    terminal?.close();
    server?.dispose();
    process.off("SIGINT", pause); process.off("SIGTERM", pause);
    await release();
  }
}

export function program(): Command {
  const cli = new Command().name("perf-swarm").description("perf-SWARM — reproducible engineering experiments in the native Codex harness").version("2.0.0");
  cli.command("gui").description("Inspect saved and live swarms in the local web dashboard")
    .option("--state-dir <path>", "Run directory or directory containing run groups", ".perf-swarm")
    .option("--port <number>", "Local dashboard port", positiveInteger, 4317)
    .action(async (options) => {
      if (options.port > 65535) throw new Error("Port must be at most 65535.");
      const dashboard = await startDashboard({ stateDir: options.stateDir, port: options.port });
      process.stdout.write(`perf-SWARM overview: ${dashboard.url}\nWatching: ${resolve(options.stateDir)}\n`);
      const stop = () => dashboard.server.close(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    });
  cli.command("start").description("Create isolated workers and start an objective").argument("<objective>")
    .option("-w, --workers <count>", "Fixed worker pool size (1–10000)", positiveInteger, 4)
    .requiredOption("--model <id>", "Main Codex model ID")
    .option("--model-mix <weights>", "Fixed-count shuffled mix: MODEL=1/3,OTHER_MODEL=2/3")
    .requiredOption("--subagent-model <id>", "User-selected model for every subagent; parents cannot override it")
    .option("--workspace <path>", "Source repository or general-task input directory", process.cwd())
    .option("--state-dir <path>", "Directory containing persistent runs", ".perf-swarm")
    .option("--thinking <level>", "none|minimal|low|medium|high|xhigh|max", "high")
    .option("--model-thinking <settings>", "Per-model effort: MODEL=max,OTHER_MODEL=low")
    .option("--no-web-search", "Disable hosted search, browser, computer, and image-generation tools")
    .option("--computer-use <manifest>", "Connect main workers to the installed Codex app's cua_repl .mcp.json")
    .option("--browser-backend <backend>", "electron: offscreen; chrome: Docker virtual desktop; chromium: headless", "electron")
    .option("--max-runtime <duration>", "Optional cumulative active-runtime budget", duration)
    .option("--max-tokens <count>", "Optional total reported-token budget for all agents", positiveInteger)
    .option("--phase-budget <settings>", "Optional phase budgets: implementation=20m,validation=10m,finalization=2m")
    .option("--stall-timeout <duration>", "Time without a heartbeat before marking a worker stalled", duration, 90_000)
    .option("--finalization-grace <duration>", "Grace period to finish a frozen validation", duration, 120_000)
    .option("--json", "Emit JSONL events; disables the interactive terminal", false)
    .option("--no-interactive", "Run without terminal input")
    .action(async (objective, options) => {
      if (options.workers > 10000) throw new Error("At most 10000 unique four-digit worker IDs are available.");
      if (!["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(options.thinking)) throw new Error("Invalid thinking level.");
      const modelThinking: NonNullable<RunConfig["modelThinking"]> = {};
      for (const setting of options.modelThinking?.split(",") ?? []) {
        const [model, level, extra] = setting.split("=");
        if (!model?.trim() || !level || extra || !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level.trim())) throw new Error("Use --model-thinking MODEL=max,OTHER_MODEL=low with valid reasoning levels.");
        modelThinking[model.trim()] = level.trim() as RunConfig["thinking"];
      }
      const phaseBudgets: NonNullable<RunConfig["phaseBudgets"]> = {};
      for (const setting of options.phaseBudget?.split(",") ?? []) {
        const [phase, value, extra] = setting.split("=");
        if (!phase || !["implementation", "validation", "finalization"].includes(phase) || !value || extra) throw new Error("Use --phase-budget implementation=20m,validation=10m,finalization=2m.");
        phaseBudgets[phase as keyof typeof phaseBudgets] = duration(value);
      }
      const config: RunConfig = {
        workers: options.workers, model: options.model, mix: options.modelMix ? parseMix(options.modelMix) : [],
        subagentModel: options.subagentModel,
        thinking: options.thinking, modelThinking, webSearch: options.webSearch, maxRuntimeMs: options.maxRuntime, maxTokens: options.maxTokens,
        computerUseManifest: options.computerUse ? resolve(options.computerUse) : undefined,
        browserBackend: options.browserBackend,
        phaseBudgets, stallTimeoutMs: options.stallTimeout, finalizationGraceMs: options.finalizationGrace,
      };
      if (!["electron", "chromium", "chrome"].includes(config.browserBackend!)) throw new Error("Use --browser-backend electron, chromium, or chrome.");
      if (config.computerUseManifest && config.webSearch === false) throw new Error("--computer-use cannot be combined with --no-web-search.");
      if (config.computerUseManifest) await computerUseConfig(config.computerUseManifest);
      // Validate models/auth before creating Git branches or copying input files.
      const server = await connectCodex();
      try { await validateModels(server, [config.model, config.subagentModel, ...config.mix.map((item) => item.model)]); config.capabilities = await new CodexDriver(server, config).preflight(); }
      finally { server.dispose(); }
      const store = await createRun(objective, options.workspace, options.stateDir, config);
      await execute(store, options.json, options.interactive && Boolean(process.stdin.isTTY));
    });
  cli.command("resume").description("Resume saved sessions, workspaces, helpers and coordination").argument("<run>")
    .option("--state-dir <path>", "Runs directory when using a run ID", ".perf-swarm")
    .option("--max-runtime <duration>", "Replace the cumulative runtime budget", duration)
    .option("--max-tokens <count>", "Replace the cumulative token budget", positiveInteger)
    .option("--reset-browser-access", "Operator reset of shared access blockers after access conditions change", false)
    .option("--browser-backend <backend>", "Change browser backend: electron, chrome (Docker), or chromium")
    .option("--json", "Emit JSONL events", false).option("--no-interactive", "Run without terminal input")
    .action(async (run, options) => {
      if (options.browserBackend && !["electron", "chromium", "chrome"].includes(options.browserBackend)) throw new Error("Use --browser-backend electron, chromium, or chrome.");
      const directory = runPath(run, options.stateDir);
      const store = Store.open(directory);
      await execute(store, options.json, options.interactive && Boolean(process.stdin.isTTY), { runtime: options.maxRuntime, tokens: options.maxTokens, resetBrowserAccess: options.resetBrowserAccess, browserBackend: options.browserBackend });
    });
  cli.command("status").description("Inspect a saved or running swarm").argument("<run>")
    .option("--state-dir <path>", "Runs directory", ".perf-swarm").option("--json", "Machine-readable status")
    .action((run, options) => {
      const store = Store.open(runPath(run, options.stateDir));
      const output = options.json ? JSON.stringify({ ...store.publicView(), id: store.state.id, tokens: store.state.tokens, elapsedMs: store.state.elapsedMs, pauseReason: store.state.pauseReason }, null, 2) : plain(describe(store));
      process.stdout.write(output + "\n");
    });
  cli.command("list").description("List saved runs").option("--state-dir <path>", "Runs directory", ".perf-swarm")
    .action(async (options) => {
      let entries;
      try { entries = await readdir(resolve(options.stateDir), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        let store;
        try { store = Store.open(resolve(options.stateDir, entry.name)); } catch { continue; }
        process.stdout.write(plain(`${store.state.id}  ${store.state.status}  ${store.state.objective}`) + "\n");
      }
    });
  cli.command("experiments").description("List durable engineering attempts for a run").argument("<run>")
    .option("--state-dir <path>", "Runs directory", ".perf-swarm")
    .option("--status <status>", "Filter by running, succeeded, failed, blocked, inconclusive, or superseded")
    .option("--query <text>", "Search hypotheses, results, and failure categories")
    .option("--json", "Machine-readable JSON")
    .action(async (run, options) => {
      const records = await new ExperimentStore(runPath(run, options.stateDir)).list({ status: options.status, query: options.query });
      process.stdout.write(options.json ? JSON.stringify(records, null, 2) + "\n" : records.map(item => `${item.id}  ${item.status}  ${item.actor}  ${item.hypothesis}`).join("\n") + (records.length ? "\n" : ""));
    });
  cli.command("models").description("List model IDs available from native Codex")
    .action(async () => {
      const server = await connectCodex();
      try { for (const id of await listModels(server)) process.stdout.write(plain(id) + "\n"); }
      finally { server.dispose(); }
    });
  cli.command("login").description("Authenticate native Codex")
    .action(async () => {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.env.PERF_SWARM_CODEX_BIN ?? "codex", ["login"], { stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Codex login exited (${code}).`)));
      });
    });
  return cli;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  program().parseAsync().catch((error) => {
    process.stderr.write(`Error: ${plain(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}

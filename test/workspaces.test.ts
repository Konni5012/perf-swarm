import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./helpers.js";
import { createRun } from "../src/run.js";
import { git, publishArtifact } from "../src/workspaces.js";
import { plain } from "../src/terminal.js";
import { duration, positiveInteger, program } from "../src/cli.js";

test("Git workers use distinct worktrees and merge into integration without changing the source branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-git-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await git(source, ["init", "-b", "main"]);
    await writeFile(join(source, "original.txt"), "original");
    await git(source, ["add", "."]);
    await git(source, ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "Initial"]);
    const before = await git(source, ["rev-parse", "HEAD"]);
    const store = await createRun("Create report", source, join(root, "runs"), config(2));
    assert.ok(store.state.git);
    const worker = store.state.workers[0]!;
    await writeFile(join(worker.workspace, "report.txt"), "report");
    await git(worker.workspace, ["add", "report.txt"]);
    await git(worker.workspace, ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "Report"]);
    // Simulate the native Git operation after the worker committed its branch.
    await git(store.state.integration, ["-c", "user.name=Test", "-c", "user.email=test@localhost", "merge", "--no-edit", worker.branch!]);
    assert.equal(await readFile(join(store.state.integration, "report.txt"), "utf8"), "report");
    assert.equal(await git(source, ["rev-parse", "HEAD"]), before);
    assert.equal(await git(source, ["branch", "--show-current"]), "main");
    await assert.rejects(() => readFile(join(store.state.workers[1]!.workspace, "report.txt")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("general-task workspaces copy inputs independently and never recursively copy state", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-general-"));
  try {
    await writeFile(join(root, "input.txt"), "input");
    const store = await createRun("Analyze input", root, join(root, ".perf-swarm"), config(2));
    assert.equal(store.state.git, false);
    for (const worker of store.state.workers) {
      assert.equal(await readFile(join(worker.workspace, "input.txt"), "utf8"), "input");
      await assert.rejects(() => readFile(join(worker.workspace, ".perf-swarm", store.state.id, "state.json")), { code: "ENOENT" });
    }
    await writeFile(join(store.state.workers[0]!.workspace, "input.txt"), "changed");
    assert.equal(await readFile(join(root, "input.txt"), "utf8"), "input");
    assert.equal(await readFile(join(store.state.workers[1]!.workspace, "input.txt"), "utf8"), "input");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("general workspace copies exclude older runs in a custom state directory and relocate internal links", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-history-"));
  try {
    await mkdir(join(root, "history", "old"), { recursive: true });
    await writeFile(join(root, "history", "old", "state.json"), "private model assignment");
    await writeFile(join(root, "input.txt"), "input");
    await symlink("input.txt", join(root, "linked.txt"));
    const store = await createRun("Analyze input", root, join(root, "history"), config(1));
    const workspace = store.state.workers[0]!.workspace;
    await assert.rejects(() => readFile(join(workspace, "history", "old", "state.json")), { code: "ENOENT" });
    await writeFile(join(workspace, "linked.txt"), "changed");
    assert.equal(await readFile(join(workspace, "input.txt"), "utf8"), "changed");
    assert.equal(await readFile(join(root, "input.txt"), "utf8"), "input");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("an input subdirectory in a Git repository uses directory workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-inputs-"));
  try {
    await git(root, ["init", "-b", "main"]);
    const input = join(root, "inputs"); await mkdir(input);
    await writeFile(join(input, "input.txt"), "input");
    await git(root, ["add", "."]);
    await git(root, ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "Initial"]);
    const store = await createRun("Analyze input", input, join(root, ".perf-swarm"), config(1));
    assert.equal(store.state.git, false);
    assert.equal(await readFile(join(store.state.workers[0]!.workspace, "input.txt"), "utf8"), "input");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("artifact publishing rejects traversal and escaping symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-artifacts-"));
  try {
    const input = join(root, "input"); await mkdir(input);
    const store = await createRun("Produce report", input, join(root, "runs"), config(1));
    const worker = store.state.workers[0]!;
    await writeFile(join(worker.workspace, "report.txt"), "report");
    await writeFile(join(root, "outside.txt"), "private");
    await symlink(join(root, "outside.txt"), join(worker.workspace, "escape.txt"));
    await symlink(root, join(store.state.integration, "escape"));
    await assert.rejects(() => publishArtifact(store.state, worker.id, "../outside.txt", "report.txt"), /inside/);
    await assert.rejects(() => publishArtifact(store.state, worker.id, "escape.txt", "report.txt"), /regular files/);
    await assert.rejects(() => publishArtifact(store.state, worker.id, "report.txt", "escape/outside.txt"), /escapes/);
    await publishArtifact(store.state, worker.id, "report.txt", "nested/report.txt");
    assert.equal(await readFile(join(store.state.integration, "nested/report.txt"), "utf8"), "report");
    assert.equal(await readFile(join(root, "outside.txt"), "utf8"), "private");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("CLI validates budgets, requires a user-selected helper model, and defaults to four workers", () => {
  assert.equal(duration("15m"), 900000);
  assert.equal(duration("2"), 2000);
  assert.equal(duration("50ms"), 50);
  for (const invalid of ["0", "-1m", "Infinity", "abc"]) assert.throws(() => duration(invalid));
  for (const invalid of ["0", "1.5", "-2", "Infinity"]) assert.throws(() => positiveInteger(invalid));
  const start = program().commands.find((command) => command.name() === "start")!;
  assert.equal(start.options.find((option) => option.long === "--workers")!.defaultValue, 4);
  assert.equal(start.options.find((option) => option.long === "--subagent-model")!.mandatory, true);
});
test("terminal output strips escape sequences and control characters", () => {
  assert.equal(plain("hello\x1b[31m red\x1b[0m\x1b]52;c;secret\x07\x00\n"), "hello red\n");
});

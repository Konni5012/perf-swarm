# perf-SWARM v2

A fork focused on durable, reproducible engineering experiments.

A terminal swarm running in **Codex’s native harness**. Give a fixed worker pool one objective. Workers organize themselves using a shared board, atomic task claims, DMs, bounded helpers, and an elected integrator. Workers finish their contribution with `tap_out`; once all workers tap out, the run records complete, blocked, or partial and stops.

Requires Node **22.19+**, a current [Codex CLI](https://learn.chatgpt.com/docs/cli), and Git for repository worktrees. The app-server must support `approvalsReviewer: "auto_review"` and experimental dynamic tools. SWARM verifies the applied sandbox and reviewer settings and fails if Codex cannot apply them.

```sh
npm install -g @openai/codex
npm install
npm run build
npm link
perf-perf-swarm login
perf-perf-swarm models
perf-perf-swarm start "Implement and verify the requested feature" \
  --model gpt-6.1-sol --subagent-model gpt-6-luna
```

Use model IDs returned by `perf-swarm models` for your account. Authentication and conversation transcripts stay in Codex’s normal storage. `PERF_SWARM_CODEX_BIN=/absolute/path/to/codex` selects a specific executable, useful when your normal `codex` command is a wrapper that does not support local `app-server`.

The default is **four workers**, each with a unique random four-digit identity and a persistent generated name such as `Mica`. Names are identity aliases only; workers choose their own work areas through coordination. Both the name and ID work in DMs and worker selectors; messages are stored against canonical IDs. Change the fixed pool with `--workers N`. Workers cannot add main workers. Each worker can spawn up to **four concurrent helpers**, with one delegation level. Helpers share their parent’s workspace, report only to their parent, and receive no board, DM, tap-out, or delegation tools. All helpers use your required `--subagent-model`; parents cannot choose a model.

For general tasks, select an input directory with `--workspace`. Each worker receives its own copy. A repository root with a committed HEAD instead gets a separate Git worktree per worker and another worktree for integration. Workers begin at the committed snapshot; uncommitted source changes are not included. Source branches are not changed by integration. Repository subdirectories use directory copies.

```sh
perf-swarm start "Research the problem and produce a sourced report" \
  --workspace ./inputs --workers 6 \
  --model gpt-6.1-sol --subagent-model gpt-6-luna \
  --model-mix 'gpt-6.1-sol=1/3,gpt-6-luna=2/3' \
  --max-runtime 30m --max-tokens 200000
```

Model mixtures use largest-remainder rounding to produce fixed counts, then shuffle assignments. With four workers and the example weights, one worker uses Sol and three use Luna. Worker prompts and coordination tools omit model assignments; workers identify themselves by worker ID. This is an identity convention, not secrecy against host filesystem access. `--thinking` selects a Codex reasoning effort; the default is `high`. Use `--model-thinking gpt-6-luna=max,gpt-6.1-sol=low` for per-model settings. `--no-web-search` disables hosted search, browser, computer, and image-generation tools; agents are also instructed not to use network research through shell commands.

Workers and helpers have native Codex shell/file tools and **live web search**. Workers also have these SWARM tools:

| Tool | Purpose |
| --- | --- |
| `swarm_status` | Read the objective, workers, tasks, tap-outs, outcome, helper reports, and message counts |
| `board` | Pull the last N shared posts (`limit`, optional `after` ID), or post a message |
| `dm` | Pull the last N own DMs (`limit`, optional `after` and `to` filter), or send a message |
| `swarm_sleep` | Park until subscribed events arrive; routine board posts do not wake workers |
| `checkpoint` | Freeze/thaw generations, record classified evidence and inspect readiness |
| `swarm_wait` | Subscribe to task closure/new generation/selected messages, then end the turn; no model polling |
| `task` | Create, claim, complete, release or cancel tasks; declare dependencies, validation work and delayed/stall-gated contingencies |
| `integrator` | Claim or release integration ownership |
| `integrate` | Prepare a Git merge, publish a regular artifact file, or switch working workspace |
| `subagent` | Spawn, inspect, or cancel parent-only helpers |
| `tap_out` | Finish your contribution with complete, blocked, or partial and concrete evidence/blockers |
| `coordination_snapshot` | New messages and changed tasks/status since the last pull; persisted cursors, pagination, optional reset |
| `browser` | Worker-owned Chromium: navigation diagnostics, text, clicks, image screenshots, viewport resize, owned tabs, browser-local input, scoped static preview |

Workers run in persistent Codex threads and pull coordination at natural checkpoints. The objective is supplied in thread instructions; ordinary turns receive a short continuation, with no automatic board/DM/task snapshot. Teammate messages stay on the board or in DMs. New operator instructions alone steer active turns, with delivery tracked across resume. The runtime tracks throttled native-tool/turn heartbeats and workspace file changes; the dashboard marks a busy worker potentially stalled after 90 seconds without activity; this separates a quiet active worker from a failed one. Quiet workers make no timed continuation calls. `swarm_wait`/`swarm_sleep` return immediately and park between turns. Task dependencies, explicitly subscribed generation changes, and relevant DMs wake sleepers; routine board posts require an explicit board subscription. Tapped-out workers ignore routine board/DM notifications. Operator instructions, changed evidence dependencies, or relevant tasks can reactivate them. Owned active work and workspace switches can continue on the next turn without waiting for coordination. Board and DM reads default to the last 20 messages (1–1000 allowed), oldest first within that window. `after` excludes messages at or below that ID; reads always select the latest N matching messages, so choose a sufficient limit when catching up. DMs report sent/delivered/read/acknowledged/answered state. Send with `requiresAck` and an optional `ackTimeoutMs`, acknowledge with `dm action ack`, and reply with `replyTo`. Status lists overdue acknowledgements. Incoming teammate DMs are pulled at natural checkpoints; they do not steer active turns. Posts and sends return receipts rather than repeating history. Blocked workers subscribe with `swarm_wait`, end the turn, and pull deltas after a relevant wake.

These tool definitions are registered when a native thread is created. Previously saved threads retain their original native tool definitions; start a new run to use the full updated tool set. Existing transcripts are preserved.

Integration ownership is exclusive. Content changes create an immutable integration generation containing a snapshot, file manifest and SHA-256 digest. Identical republishes and workspace switches preserve tap-outs. Native integration edits are detected at turn completion; merge preparation itself does not assert that a merge happened. `integrate workspace` switches the elected worker’s native working directory on its **next turn**. The worker ends the current turn, then uses Codex’s native shell/edit tools to verify or resolve conflicts in integration. `integrate merge` prepares the committed worker branch’s Git merge command and selects integration for the next turn; it does not execute a host shell command. `integrate publish` copies one explicitly named regular file with traversal and symlink checks. The integrator can switch back to its own workspace. Helpers remain in the parent’s original workspace.

The terminal accepts:

```text
/status
/board
/post New shared instruction
/dm worker-1234 Focus on the tests
/dms
/tasks
/tapouts
/pause
/help
```

You can see all DMs as the operator; workers’ coordination tools expose only their own conversations. Use `--no-interactive` for unattended execution or `--json` for JSONL events. New operator messages steer active workers; teammate messages are pulled through tools.

Finish useful implementation and validation, then call **`tap_out` once** with complete, blocked, or partial and concrete findings. It automatically marks owned tasks done for complete, or cancelled with the reported reason for partial/blocked. Finish or cancel active helpers first. No freeze, per-worker evidence entry, or separate task-closure call is required. The first tap-out does not start a finalization timer while others are still working.

`checkpoint freeze` and structured evidence remain optional for immutable reviews. Evidence carries forward when its declared file hashes remain unchanged. Unresolved findings remain visible and can downgrade the final outcome; they do not veto tap-out. Do not edit documentation or create another generation merely to clear a stale readiness flag.

All workers tapped out ends the run immediately, without an auditor or majority threshold. Any blocked report yields blocked; all complete with no unresolved findings yields complete; otherwise partial. Essential inaccessible requirements should be reported blocked. Outcomes preserve concrete findings and limitations instead of asking workers to repeat closeout.

SWARM uses [Codex’s native sandbox and automatic review](https://learn.chatgpt.com/docs/cyber-safety/recommended-configuration#review-sensitive-codex-actions):

```text
approval_policy = on-request
approvals_reviewer = auto_review
sandbox = workspace-write (workers/helpers), read-only (frozen validation)
```

Native shell/edit calls run within Codex’s permission boundary. Approval requests are reviewed by Codex’s model-based reviewer; routine calls already permitted by the sandbox proceed normally. Native review outcomes and available rationales are recorded in `events.jsonl` and shown in the terminal. If a request still requires operator input, SWARM declines it and pauses with the reason, preserving state for inspection. It never automatically approves a human approval request or selects full filesystem access.

Codex’s built-in multi-agent delegation and message board are disabled. Inherited MCP servers, apps, plugin tools, and tool suggestions are disabled so SWARM can control the helper tool surface. Sandbox command networking starts disabled; live hosted web search is enabled separately. The sandbox protects writes, not complete read isolation between local workers. SWARM’s custom tools perform structurally scoped coordination and artifact operations; they do not run a second model reviewer. Git metadata writes or verification that needs more permissions can invoke native Codex review.

Before creating worker workspaces, capability preflight verifies the configured app MCP connection and required tool inventory. This does not certify app grants, target accessibility, screenshots or browser performance; those remain explicit verification tasks. Resume repeats connection discovery. Opt in to the installed app’s Computer Use runtime with `--computer-use /absolute/path/to/unified-computer-use/VERSION/.mcp.json`. The manifest is normally under `~/.codex/plugins/cache/openai-bundled/`. SWARM loads only its `cua_repl` server for main workers, with `js`, `js_reset`, and turn-cleanup tools; helpers remain disconnected. App plugins and unrelated inherited MCP servers remain disabled. This flag cannot be combined with `--no-web-search`. The app must be installed and its app-access and OS permissions still apply; connecting the MCP process does not grant those permissions. Each worker should use its own named browser session and coordinate exclusive desktop-app access. Native sandbox and approval settings remain unchanged. SWARM sends the app’s turn-ended notification on completion/interruption. This integration has been verified for standalone tool discovery; browser screenshots and concurrent UI access still need end-to-end validation. Start a fresh run to use it; the current run’s threads are not modified.

The default browser backend is a background Electron companion. Installation preflight does not launch it: the first agent browser request starts it automatically. Every worker owns hidden offscreen Chromium windows and a persistent session partition, stored under that run's `browser/profiles` directory. It opens no browser windows, does not focus an application, and hides its Dock icon on macOS. No menu-bar item, login-start registration, personal profile import, or desktop-input automation is installed.

Agents can navigate, inspect text and interactive elements, click selectors or screenshot coordinates, type, send keys, scroll, resize, and create/select/close owned tabs. Input routes to the browser surface rather than your physical keyboard or mouse. Browser windows use sandboxed renderers with Node integration disabled; permission requests, downloads, and automatic popups are denied. File pickers are intercepted and page dialogs are disabled (with dismissal as defense in depth) to keep native prompts off your desktop. Agents can open additional tabs explicitly. Background throttling is disabled and offscreen painting is capped at 30fps. Screenshot results arrive as native image inputs, not base64 text. `browser preview` serves only the worker's authorized workspace or frozen snapshot on loopback with traversal/symlink checks.

The dashboard's agent inspector has an **Open browser** tab that displays the current browser frame, refreshed every two seconds while the viewer is open and the dashboard is visible. It is a passive viewer: it cannot start browser sessions, navigate, wake agents, or alter input. Closing the viewer leaves the run operating. Frames pass through the loopback dashboard to an authenticated run-local service; the browser service credential is never exposed to the web page or agent tools. Pause/completion stops the companion and removes its live service descriptor; profiles remain available for resume. A companion watchdog quits if its owning swarm process dies.

Use **`--browser-backend chrome`** for ordinary headed Google Chrome inside one Docker virtual desktop per agent. Each container has a private Xvfb display and persistent profile; native windows never appear on your desktop. It starts lazily, uses the same browser tools and **Open browser** dashboard viewer, and stops on pause/completion. A heartbeat watchdog terminates containers after the owning swarm dies. No host display socket, personal browser profile, workspace, or Docker socket is mounted into the container. Only that worker's profile and a read-only owner heartbeat are mounted. The debugging endpoint is bound exclusively to host loopback; it is not exposed to dashboard clients or worker tools. Local static previews are forwarded through automation, without exposing a host web server to the container network.

Install/start a Docker-compatible **Linux** runtime, then build the browser image once:

```sh
npm run browser:chrome:build
# Installed package: node /path/to/perf-swarm/dist/virtual-chrome/build.mjs
perf-swarm start "Your objective" --model gpt-6.1-sol --subagent-model gpt-6-luna --browser-backend chrome
perf-swarm resume RUN_ID --browser-backend chrome
```

On Apple Silicon, a background Colima runtime can use a dedicated context without opening a desktop app or changing your default Docker context. This setup was verified on the development Mac:

```sh
brew install colima docker
mkdir -p .perf-swarm
colima start swarm --vm-type vz --vz-rosetta --cpu 4 --memory 3 --disk 30 \
  --activate=false --ssh-config=false --mount "$PWD/.perf-swarm:w" --mount /private/tmp:w
export DOCKER_CONTEXT=colima-swarm
npm run browser:chrome:build
```

Keep that context in the environment when starting/resuming Chrome-backed swarms. The VM remains a background runtime; `colima stop swarm` stops it when you no longer need it. Chrome receives an explicit graceful shutdown before its container exits so persistent cookies are flushed.

The image installs Google Chrome stable for amd64. Apple Silicon requires Docker's amd64 emulation, with additional startup/CPU cost. Containers are bounded to two CPUs, 2GiB memory, 512MiB shared memory, and 256 processes each. Docker runs without added capabilities and with privilege escalation disabled. Chrome's internal OS sandbox is disabled inside this container; the container/VM provides the OS boundary, so this backend's isolation differs from Electron's sandboxed renderers. Docker/image checks happen during preflight; SWARM never installs Docker, builds/pulls the image, or silently falls back during a run. Stable Chrome compatibility does not guarantee access to Cloudflare-protected sites. Manual browser takeover is not included in this backend.

Use `--browser-backend chromium` at start or resume for an explicit headless Playwright pivot. It does not launch visible Chrome windows. Electron is the default; startup errors are reported rather than silently selecting another backend. A system login or CAPTCHA that requires human interaction is currently a blocker: this first viewer is read-only. No Cloudflare challenge bypass is implemented.

Reference-access failures are shared per origin and serialized across workers. After two identical challenge, HTTP, application-load, or navigation failures, further navigation attempts return the saved blocker without network retries. An operator can reset the cap on resume with `--reset-browser-access` after conditions change. Workers cannot reset it. Navigation inspects the page after a bounded loading interval and reports failed resources: HTTP 200 alone is not proof of a usable page. Managed local previews never enter the shared access-blocker system: missing files return retryable diagnostics. Browser process/tab crashes are runtime failures, not origin access failures, and crashed owned tabs are recreated on the next call. `browser preview` accepts an optional `url` containing a relative, absolute, or file-URL entry path within the authorized workspace (for example `white-swarm-hero/index.html`); symlink/path escapes are rejected. Challenge/CAPTCHA/security controls are not bypassed.

On 2026-10-05, isolated reference checks reproduced a headless HTTP 403 Cloudflare challenge. Headed Chromium initially received HTTP 200 article HTML, but required JavaScript/backend resources returned 403; the hydrated page changed to “This page couldn’t load.” The article hero remained unavailable. Headed mode alone therefore does not solve this reference's access restriction; use user-provided reference media or wait for access conditions to change. A follow-up check using the hidden Electron companion reproduced the same HTTP 200 followed by failed 403 resources and an application-load error. Offscreen isolation solves desktop disruption, but does not establish access to this reference. A subsequent stock Google Chrome/Xvfb check in the Colima virtual desktop loaded the article without that application error and visibly rendered the particle hero. This is an observed successful access check, not a guarantee that later sessions will avoid challenges.

State defaults to `.perf-swarm`; change it with `--state-dir`. Directory copies exclude `.git`, `.perf-swarm`, `.pi`, `.codex`, `node_modules`, and the configured run directory. Internal symlinks are relocated; external/dangling links are skipped. Saved state contains thread IDs, model allocation, workspaces, board, DMs, tasks, helpers, tap-outs, outcomes, evidence dependencies, subscriptions, snapshot cursors, access blockers, and budgets. A heartbeat lock prevents concurrent run/resume processes. Keep Codex’s own session storage when moving or resuming runs. This lifecycle uses state schema 4; earlier saved runs are not resumed or migrated. Start a fresh run for the checkpoint tools and thread instructions.

```sh
perf-swarm list
perf-swarm status RUN_ID
perf-swarm resume RUN_ID
perf-swarm resume RUN_ID --max-runtime 1h --max-tokens 400000
```

Workers recover under the same ID and Codex thread with up to three restarts; a fourth failure pauses the run. Explicit resume grants a fresh recovery cycle. Helpers that were running when paused resume their saved threads.

### Swarm overview GUI

```sh
perf-swarm gui                           # http://127.0.0.1:4317
perf-swarm gui --state-dir .perf-swarm --port 4317
perf-swarm gui --state-dir .perf-swarm/my-run  # inspect a single run
```

The local, read-only dashboard discovers runs and run groups under the selected directory and refreshes every two seconds. It shows an activity flame graph (wall time or reported tokens), the complete message board, all operator-visible DMs with conversation filters, agent/token/turn totals, tasks, worker tap-outs, and explicit run outcomes. Click an agent or turn to inspect its workspace, model, thread, tools, messages, helpers, and task evidence. Search and “Load earlier” expose older messages and turns. Viewing a swarm never starts or resumes it and makes no model calls.

New runs append native turn boundaries, non-reasoning tool/message details, and incremental token usage to `telemetry.jsonl`. Historical runs without telemetry show dispatch intervals reconstructed from `events.jsonl`, clearly marked as estimates; their per-turn token splits are unavailable. The token flame graph groups helpers under their parent and labels unassigned usage explicitly. Reported tokens include cached context and are not a billing estimate. Telemetry and message logs stay local and can contain task content; the dashboard binds only to loopback and rejects cross-origin API requests.

Task cancellation records the reason/superseding task and automatically messages the actual owner. `blockedBy` gates dependencies; `delayMs` delays availability and `contingencyFor` additionally requires the primary worker to be stalled or failed. Tasks and integration ownership emerge from worker coordination; no work roles are assigned.

Evidence is classified as verified, partially verified, inaccessible with documented attempts, unverified or contradicted. Each worker’s unresolved objection remains blocking until that worker records a resolution. Inaccessible/partial evidence does not automatically waive an essential objective requirement.

Optional `--max-runtime` counts cumulative active time, excluding pauses. A frozen validation/finalization attempt receives a single bounded `--finalization-grace` (default 2m) to finish. Thawing does not renew grace and token limits still pause immediately. `--phase-budget implementation=20m,validation=10m,finalization=2m` sets optional cumulative phase budgets; `--stall-timeout` tunes liveness. `--max-tokens` counts cumulative usage reported by Codex for SWARM threads, including cached tokens, without recounting persisted usage after resume. Budgets pause and save. In-flight concurrent calls may exceed token limits before interruption. Native internal review/compaction usage is counted only to the extent Codex includes it in thread usage notifications; this is not a hard billing quota.

Development:

```sh
npm run check
npm test
npm run build
```

Tests exercise the real stdio transport against an offline protocol fixture, plus scripted coordination, real filesystem operations, and temporary Git repositories. Set `SWARM_TEST_VIRTUAL_CHROME=1 npm test` with Docker running and the image built to also execute the real virtual-desktop integration test; otherwise that test is explicitly skipped. Container orchestration, ownership, failed-start cleanup, and preflight are tested without Docker. They cover native policy enforcement in requests, reviewer denials, role boundaries, thread resume, streaming, interruption races, budgets, recovery, tap-out lifecycle, incremental snapshots, evidence reuse, subscriptions, browser diagnostics, and integration. Tests make no paid model calls. SWARM’s dynamic tools and native review notifications use experimental app-server fields; keep Codex current.

### Durable experiment ledger

`perf-SWARM` preserves every engineering attempt instead of keeping only the latest workspace. Workers use the `experiment` tool to create a hypothesis, add checkpoints and metrics, and finish it as `succeeded`, `failed`, `blocked`, or `inconclusive`. A finished attempt is immutable; retries are new attempts linked with `parent`.

Each attempt stores metadata, an append-only `events.jsonl` history, a workspace snapshot, `diff.patch`, result text, failure category, tags, and metrics under `.perf-swarm/<run>/experiments/<attempt>/`. Operators can inspect the ledger without resuming a run:

```sh
perf-swarm experiments RUN_ID
perf-swarm experiments RUN_ID --status failed --json
perf-swarm experiments RUN_ID --query "memory"
```

### Apple Silicon MPS environment

For local ResNet development on an Apple Silicon Mac, provision the shared worker environment once from the target Git repository:

```sh
brew install python@3.12
npm run env:mps:setup
export PATH="$PWD/.perf-swarm/python/bin:$PATH"
perf-swarm start "Optimize the ResNet model to the local MPS target" \
  --workspace /path/to/resnet-repository --workers 6 \
  --model gpt-6-luna --subagent-model gpt-6-luna --thinking xhigh
```

`requirements-mps.txt` installs PyTorch, torchvision, and process metrics. `scripts/check-mps-env.py` verifies an arm64 host, a PyTorch build with MPS support, and an available MPS device. MPS is a local-development backend; its reported MFU is a proxy based on the device peak supplied by the benchmark and is not interchangeable with NVIDIA CUDA MFU.

This makes negative results searchable and replayable evidence. Workers should search prior attempts before repeating a strategy, record why an approach failed, and link meaningful variations to their parent attempt.

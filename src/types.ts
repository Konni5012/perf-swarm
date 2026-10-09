export type ModelSpec = string;
export interface ModelWeight { model: ModelSpec; weight: number }
export interface RunConfig {
  workers: number;
  model: ModelSpec;
  mix: ModelWeight[];
  subagentModel: ModelSpec;
  thinking: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  modelThinking?: Record<string, RunConfig["thinking"]>;
  webSearch?: boolean;
  computerUseManifest?: string;
  browserBackend?: import("./browser.js").BrowserBackend;
  maxRuntimeMs?: number;
  maxTokens?: number;
  stallTimeoutMs?: number;
  finalizationGraceMs?: number;
  capabilities?: { webSearch: boolean; computerUse: "disabled" | "connected" | "failed"; browser: "disabled" | "ready" | "unavailable"; detail: string };
  phaseBudgets?: Partial<Record<WorkPhase, number>>;
}
export type WorkPhase = "implementation" | "validation" | "finalization";
export interface ArtifactGeneration { number: number; author: string; snapshot: string; createdAt: string; digest: string; files: Record<string, string> }
export interface Evidence { id: number; actor: string; generation: number; requirement: string; status: "verified" | "partially_verified" | "inaccessible" | "unverified" | "contradicted"; detail: string; files?: Record<string, string>; scope?: "files" | "artifact"; obsolete?: boolean; reusedFrom?: number }
export type AgentStatus = "idle" | "running" | "tapped_out" | "failed";
export interface Worker {
  id: string;
  /** Human-friendly emergent identity; deliberately carries no role assignment. */
  name?: string;
  model: ModelSpec;
  workspace: string;
  branch?: string;
  threadId?: string;
  accountedTokens?: number;
  status: AgentStatus;
  restarts: number;
  lastError?: string;
  integrationMode?: boolean;
  deliveredUserMessageId?: number;
  lastHeartbeatAt?: string;
  lastActivityAt?: string;
  stallSince?: string;
  waiting?: boolean;
  waitReason?: string;
  lastFileChangeAt?: string;
  lastTurnAt?: string;
  lastToolAt?: string;
  parked?: boolean;
  subscription?: Subscription;
  snapshotCursor?: { board: number; dm: number; status: string; tasks: Record<string, string> };
}
export interface Child {
  id: string;
  parent: string;
  task: string;
  status: "pending" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  threadId?: string;
  accountedTokens?: number;
  result?: string;
}
export interface Post { id: number; author: string; text: string; at: string }
export interface DirectMessage extends Post { to: string; status?: "sent" | "delivered" | "read" | "acknowledged" | "answered"; requiresAck?: boolean; ackDeadline?: string; replyTo?: number; readAt?: string; acknowledgedAt?: string }
export interface Task {
  id: number;
  title: string;
  description: string;
  owner?: string;
  status: "open" | "claimed" | "done" | "cancelled";
  kind?: "implementation" | "validation";
  contingencyFor?: string;
  blockedBy?: number[];
  supersededBy?: number;
  availableAt?: string;
  availabilityNotified?: boolean;
  result?: string;
}
export interface TapOut { outcome: "complete" | "blocked" | "partial"; reason: string; generation: number; digest?: string }
export interface Subscription { tasks?: number[]; generation?: boolean; board?: boolean; dms?: boolean }
export interface RunState {
  version: 4;
  id: string;
  objective: string;
  source: string;
  createdAt: string;
  status: "ready" | "running" | "paused" | "completed";
  pauseReason?: string;
  config: RunConfig;
  workers: Worker[];
  children: Child[];
  board: Post[];
  dms: DirectMessage[];
  tasks: Task[];
  tapouts: Record<string, TapOut>;
  outcome?: { status: "complete" | "blocked" | "partial"; reasons: string[] };
  revision: number;
  integrator?: string;
  integration: string;
  git: boolean;
  baseCommit?: string;
  elapsedMs: number;
  tokens: number;
  sequence: number;
  artifactGeneration?: number;
  frozenGeneration?: number;
  freezeAt?: string;
  artifacts?: ArtifactGeneration[];
  evidence?: Evidence[];
  phase?: WorkPhase;
  phaseElapsedMs?: Partial<Record<WorkPhase, number>>;
  coordinationRevision?: number;
  evidenceRevision?: number;
  browserAccess?: import("./browser.js").AccessFailure[];
  graceDeadlineElapsedMs?: number;
  capabilities?: { webSearch: boolean; computerUse: "disabled" | "connected" | "failed"; browser: "disabled" | "ready" | "unavailable"; detail: string };
}
export interface RunEvent {
  at: string;
  type: string;
  actor?: string;
  message: string;
}
export interface TelemetryEvent {
  at: string;
  actor: string;
  kind: "turn-start" | "turn-end" | "item-start" | "item-end" | "usage";
  turnId?: string;
  itemId?: string;
  itemType?: string;
  status?: string;
  tokens?: number;
  detail?: string;
}

export type ExperimentStatus = "running" | "succeeded" | "failed" | "blocked" | "inconclusive" | "superseded";
export interface ExperimentRecord {
  id: string;
  actor: string;
  hypothesis: string;
  objective: string;
  status: ExperimentStatus;
  createdAt: string;
  completedAt?: string;
  parent?: string;
  workspace: string;
  snapshot?: string;
  baseCommit?: string;
  result?: string;
  failureCategory?: string;
  metrics?: Record<string, number | string | boolean>;
  tags?: string[];
  diff?: string;
}

import { upsertLedgerEntry, type ContextLedgerEntry, type TokenConfidence } from "../domain/index.ts";

export type PiContextLifecycleEventType =
  | "session_start"
  | "resources_discover"
  | "input"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "context"
  | "before_provider_request"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "tool_result"
  | "session_before_switch"
  | "session_before_fork"
  | "session_before_compact"
  | "session_compact"
  | "session_shutdown"
  | "model_select";

export type PiContextLifecycleRecord = {
  type: PiContextLifecycleEventType;
  at: string;
  reason?: string;
};

export type PiContextUsageSnapshot = {
  capturedAt: string;
  event: PiContextLifecycleEventType;
  tokens?: number;
  contextWindow?: number;
  percent?: number;
  tokenConfidence: TokenConfidence;
};

export type PiContextSessionMetadata = {
  sessionId?: string;
  sessionFile?: string;
  sessionDir?: string;
  cwd?: string;
  worktree?: string;
  modelProvider?: string;
  modelId?: string;
  modelName?: string;
  contextWindow?: number;
};

export type PiContextSessionState = {
  active: boolean;
  generation: number;
  startedAt?: string;
  lastUpdatedAt?: string;
  startReason?: string;
  previousSessionFile?: string;
  metadata: PiContextSessionMetadata;
  ledgerEntries: ContextLedgerEntry[];
  usageSnapshots: PiContextUsageSnapshot[];
  lifecycleEvents: PiContextLifecycleRecord[];
  beforeFirstProviderRequest: boolean;
  firstProviderRequestAt?: string;
  resetReason?: string;
  warnings: string[];
};

export type StartSessionStateInput = {
  reason: string;
  at?: string;
  previousSessionFile?: string;
  metadata?: PiContextSessionMetadata;
  usageSnapshot?: Omit<PiContextUsageSnapshot, "capturedAt" | "event">;
  warnings?: string[];
};

export type UpdateSessionStateInput = {
  at?: string;
  event?: PiContextLifecycleEventType;
  reason?: string;
  metadata?: PiContextSessionMetadata;
  usageSnapshot?: Omit<PiContextUsageSnapshot, "capturedAt" | "event">;
  warnings?: string[];
};

export type RecordLedgerEntriesInput = {
  at?: string;
  entries: ContextLedgerEntry[];
  warnings?: string[];
};

const MAX_LEDGER_ENTRIES = 500;
const MAX_USAGE_SNAPSHOTS = 120;
const MAX_LIFECYCLE_EVENTS = 300;
const MAX_WARNINGS = 120;

let currentState: PiContextSessionState | undefined;
let generation = 0;

export function getSessionState(): PiContextSessionState | undefined {
  return currentState ? cloneState(currentState) : undefined;
}

export function startSessionState(input: StartSessionStateInput): PiContextSessionState {
  const at = input.at ?? new Date().toISOString();
  generation += 1;
  currentState = {
    active: true,
    generation,
    startedAt: at,
    lastUpdatedAt: at,
    startReason: input.reason,
    previousSessionFile: input.previousSessionFile,
    metadata: { ...(input.metadata ?? {}) },
    ledgerEntries: [],
    usageSnapshots: [],
    lifecycleEvents: [{ type: "session_start", at, reason: input.reason }],
    beforeFirstProviderRequest: true,
    warnings: uniqueStrings(input.warnings ?? []),
  };
  if (input.usageSnapshot) recordUsageSnapshot("session_start", input.usageSnapshot, at);
  return cloneState(currentState);
}

export function resetSessionState(reason: string, at = new Date().toISOString()): PiContextSessionState {
  generation += 1;
  currentState = {
    active: false,
    generation,
    lastUpdatedAt: at,
    metadata: {},
    ledgerEntries: [],
    usageSnapshots: [],
    lifecycleEvents: [{ type: "session_shutdown", at, reason }],
    beforeFirstProviderRequest: true,
    resetReason: reason,
    warnings: [],
  };
  return cloneState(currentState);
}

export function updateSessionState(input: UpdateSessionStateInput): PiContextSessionState {
  const at = input.at ?? new Date().toISOString();
  const state = ensureState(at);
  state.lastUpdatedAt = at;
  if (input.metadata) state.metadata = { ...state.metadata, ...definedMetadata(input.metadata) };
  if (input.event) {
    state.lifecycleEvents = trimTail([...state.lifecycleEvents, { type: input.event, at, reason: input.reason }], MAX_LIFECYCLE_EVENTS);
    if (input.event === "before_provider_request" && state.beforeFirstProviderRequest) {
      state.beforeFirstProviderRequest = false;
      state.firstProviderRequestAt = at;
    }
    if (input.event === "session_compact") state.ledgerEntries = [];
  }
  if (input.warnings?.length) state.warnings = trimTail(uniqueStrings([...state.warnings, ...input.warnings]), MAX_WARNINGS);
  if (input.usageSnapshot && input.event) recordUsageSnapshot(input.event, input.usageSnapshot, at);
  return cloneState(state);
}

export function recordLedgerEntries(input: RecordLedgerEntriesInput): PiContextSessionState {
  const at = input.at ?? new Date().toISOString();
  const state = ensureState(at);
  state.lastUpdatedAt = at;
  for (const entry of input.entries) state.ledgerEntries = upsertLedgerEntry(state.ledgerEntries, entry);
  state.ledgerEntries = trimTail(state.ledgerEntries, MAX_LEDGER_ENTRIES);
  if (input.warnings?.length) state.warnings = trimTail(uniqueStrings([...state.warnings, ...input.warnings]), MAX_WARNINGS);
  return cloneState(state);
}

export function recordUsageSnapshot(
  event: PiContextLifecycleEventType,
  snapshot: Omit<PiContextUsageSnapshot, "capturedAt" | "event">,
  at = new Date().toISOString(),
): PiContextSessionState {
  const state = ensureState(at);
  state.lastUpdatedAt = at;
  state.usageSnapshots = trimTail(
    [
      ...state.usageSnapshots,
      {
        capturedAt: at,
        event,
        tokens: snapshot.tokens,
        contextWindow: snapshot.contextWindow,
        percent: snapshot.percent,
        tokenConfidence: snapshot.tokenConfidence,
      },
    ],
    MAX_USAGE_SNAPSHOTS,
  );
  if (snapshot.contextWindow !== undefined) state.metadata.contextWindow = snapshot.contextWindow;
  return cloneState(state);
}

export function clearLedgerEntries(at = new Date().toISOString()): PiContextSessionState {
  const state = ensureState(at);
  state.ledgerEntries = [];
  state.lastUpdatedAt = at;
  return cloneState(state);
}

function ensureState(at: string): PiContextSessionState {
  if (currentState) return currentState;
  generation += 1;
  currentState = {
    active: true,
    generation,
    startedAt: at,
    lastUpdatedAt: at,
    startReason: "lazy",
    metadata: {},
    ledgerEntries: [],
    usageSnapshots: [],
    lifecycleEvents: [{ type: "session_start", at, reason: "lazy" }],
    beforeFirstProviderRequest: true,
    warnings: ["session_start was not observed; state initialized lazily"],
  };
  return currentState;
}

function definedMetadata(metadata: PiContextSessionMetadata): PiContextSessionMetadata {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)) as PiContextSessionMetadata;
}

function cloneState(state: PiContextSessionState): PiContextSessionState {
  return {
    ...state,
    metadata: { ...state.metadata },
    ledgerEntries: state.ledgerEntries.map((entry) => ({
      ...entry,
      turnIds: [...entry.turnIds],
      messageIds: [...entry.messageIds],
      toolCallIds: [...entry.toolCallIds],
      redaction: entry.redaction ? { ...entry.redaction } : undefined,
      sourceMetadata: entry.sourceMetadata ? { ...entry.sourceMetadata } : undefined,
    })),
    usageSnapshots: state.usageSnapshots.map((snapshot) => ({ ...snapshot })),
    lifecycleEvents: state.lifecycleEvents.map((event) => ({ ...event })),
    warnings: [...state.warnings],
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function trimTail<T>(values: T[], max: number): T[] {
  return values.length > max ? values.slice(values.length - max) : values;
}

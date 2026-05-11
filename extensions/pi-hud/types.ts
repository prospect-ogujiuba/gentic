import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type HudComponentId = "model" | "context" | "git" | "session" | "agent" | "tools" | "events";
export type AgentState = "idle" | "thinking" | "reading" | "editing" | "writing" | "executing" | "testing";
export type Placement = "footer" | "widget" | "both";

export type Theme = {
  fg(color: any, text: string): string;
  bg?: (color: any, text: string) => string;
};

export interface ActiveTool {
  id: string;
  toolName: string;
  args?: Record<string, unknown>;
}

export interface GitStatus {
  branch: string;
  dirty: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  upstream?: string;
  remoteName?: string;
  aheadCount: number;
  behindCount: number;
}

export interface UsageSnapshot {
  input?: number;
  output?: number;
  cost?: number;
  totalTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextPct?: number;
}

export interface HudSnapshot {
  modelId?: string;
  worktreeId: string;
  usage?: UsageSnapshot;
  git?: GitStatus;
  activeTools: ActiveTool[];
  toolCounts: Record<string, number>;
  recentEvents: string[];
  thinkingLevel?: string;
}

export interface HudModalHandle {
  update(snapshot: HudSnapshot): void;
}

export interface HudState {
  enabled: boolean;
  placement: Placement;
  components: Record<HudComponentId, boolean>;
  agent: AgentState;
  turn: number;
  recentEvents: string[];
  activeTools: ActiveTool[];
  toolCounts: Record<string, number>;
  successCalls: number;
  errorCalls: number;
  warningCalls: number;
  thinkingLevel?: string;
  modal?: HudModalHandle;
}

export type SnapshotContext = Pick<ExtensionContext, "cwd" | "model" | "getContextUsage">;

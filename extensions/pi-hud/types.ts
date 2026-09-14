import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiContextHudSnapshot } from "../pi-context/src/app/index.ts";

export type AgentState = "idle" | "thinking" | "reading" | "editing" | "writing" | "executing" | "testing";
export type DisplayMode = "off" | "widget-first";

export type Theme = {
  fg(color: any, text: string): string;
  bg?: (color: any, text: string) => string;
};

export interface ActiveTool {
  id: string;
  toolName: string;
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

export type GitSnapshotStatus = "loading" | "fresh" | "stale" | "unavailable" | "error";

export interface GitSnapshotState {
  status: GitSnapshotStatus;
  generation: number;
  snapshot?: GitStatus;
  updatedAt?: number;
  error?: { code: string; message: string };
}

export interface UsageSnapshot {
  contextTokens?: number;
  contextWindow?: number;
  contextPct?: number;
}

export interface HudSnapshot {
  modelId?: string;
  worktreeId: string;
  usage?: UsageSnapshot;
  piContext?: PiContextHudSnapshot;
  git?: GitStatus;
  gitState?: GitSnapshotState;
  activeTools: ActiveTool[];
  activity?: AgentState;
}

export interface HudState {
  displayMode: DisplayMode;
  agent: AgentState;
  activeTools: ActiveTool[];
}

export type SnapshotContext = Pick<ExtensionContext, "cwd" | "model" | "getContextUsage" | "getSystemPrompt">
  & Partial<Pick<ExtensionContext, "sessionManager">>;

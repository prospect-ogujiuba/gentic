import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  CONTEXT_TELEMETRY_LIMITS,
  type ContextTelemetryContributor,
  type ContextTelemetryContributorDetail,
  type ContextTelemetryContributorKind,
  type ContextTelemetryDiagnostic,
  type ContextTelemetryPressure,
  type ContextTelemetrySnapshot,
} from "../../../../src/contracts/context-telemetry.ts";

/** Command-only Pi APIs required by the bounded native compatibility adapter. */
export type NativeSnapshotContext = Pick<
  ExtensionCommandContext,
  "getContextUsage" | "getSystemPromptOptions" | "sessionManager"
>;

export const NATIVE_SNAPSHOT_LIMITS = CONTEXT_TELEMETRY_LIMITS;

export const NATIVE_SNAPSHOT_SOURCES = Object.freeze([
  "ctx.getContextUsage()",
  "ctx.getSystemPromptOptions()",
  "ctx.sessionManager.getBranch()",
] as const);

/** These high-frequency observations are deliberately outside the native snapshot design. */
export const EXCLUDED_RUNTIME_LEDGER_EVENTS = Object.freeze([
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_result",
] as const);

export type NativeContributorKind = ContextTelemetryContributorKind;
export type NativeContributorDetail = ContextTelemetryContributorDetail;
export type NativeSnapshotDiagnostic = ContextTelemetryDiagnostic;
export type NativeSnapshotPressure = ContextTelemetryPressure;
export type NativeSnapshotContributor = ContextTelemetryContributor;
export type NativeContextSnapshot = ContextTelemetrySnapshot;

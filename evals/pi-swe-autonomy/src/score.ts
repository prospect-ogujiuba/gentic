import { createHash } from "node:crypto";

import { findForbiddenCanonicalMutations, type CanonicalMutation, type ScoreSnapshot } from "./canonical-diff.ts";
import { EVALUATION_SCHEMA_VERSION, type EvaluationEvent, type ModelTrialIdentity, type TrialScore } from "./types.ts";

export type { ScoreSnapshot } from "./canonical-diff.ts";

export type VerificationCommand = {
  readonly toolCallId: string;
  readonly command: string;
  readonly exitCode: number;
};

export type LifecycleScore = {
  readonly executionStarted: boolean;
  readonly expectedContractOrder: readonly string[];
  readonly completionOrder: readonly string[];
  readonly verificationCommands: readonly VerificationCommand[];
  readonly validEvidenceContracts: readonly string[];
  readonly completionStatuses: readonly { contractId: string; status: string }[];
  readonly retries: {
    readonly modelCompletion: number;
    readonly provider: number;
    readonly harness: number;
  };
  readonly blockerResponded: boolean;
  readonly finalReconciled: boolean;
};

export type DeterministicTrialScore = TrialScore & {
  readonly lifecycle: LifecycleScore;
  readonly criticalViolations: readonly CanonicalMutation[];
};

export type ScoreTrialInput = {
  readonly identity: ModelTrialIdentity;
  readonly events: readonly EvaluationEvent[];
  readonly before: ScoreSnapshot;
  readonly after: ScoreSnapshot;
  readonly manifestPath: string;
  readonly contractIndexPath: string;
};

type JsonRecord = Record<string, unknown>;
type ToolCall = { readonly toolName: string; readonly args: JsonRecord };

const VERIFICATION_COMMAND = /(?:^|\s)(?:npm|pnpm|yarn|node|npx|bun|deno|tsc|pytest|cargo|go)(?:\s|$).*(?:test|check|typecheck|lint)|(?:^|\s)(?:pytest|cargo\s+test|go\s+test|tsc)(?:\s|$)/i;
const FINAL_STATES = new Set(["finalizing", "complete", "completed"]);

export function scoreTrial(input: ScoreTrialInput): DeterministicTrialScore {
  const beforeManifest = parseObjectFile(input.before, input.manifestPath);
  const beforeIndex = parseObjectFile(input.before, input.contractIndexPath);
  const afterManifest = parseObjectFile(input.after, input.manifestPath);
  const afterIndex = parseObjectFile(input.after, input.contractIndexPath);
  const expectedContracts = executableContracts(beforeIndex);
  const expectedOrder = expectedContracts.map((contract) => contract.id);
  const dependencies = new Map(expectedContracts.map((contract) => [contract.id, contract.dependsOn]));
  const calls = new Map<string, ToolCall>();
  const completionAttempts = new Map<string, number>();
  const completionOrder: string[] = [];
  const completionStatuses: Array<{ contractId: string; status: string }> = [];
  const verificationCommands: VerificationCommand[] = [];
  const successfulVerificationSinceCompletion: VerificationCommand[] = [];
  const evidenceByContract = new Map<string, VerificationCommand>();
  let executionStarted = false;
  let providerRetries = 0;
  let harnessReruns = 0;
  let blockerResponded = false;
  let reconciliationObserved = false;

  for (const event of input.events) {
    const payload = asObject(event.payload);
    if (event.kind === "contract_execution_start") executionStarted = true;
    if (event.kind === "auto_retry_start") providerRetries += 1;
    if (event.kind === "harness_trial_rerun") harnessReruns += 1;
    if (event.kind === "contract_blocked" || event.kind === "blocker_response") blockerResponded = true;
    if (event.kind === "final_reconciliation") reconciliationObserved = true;
    if (event.kind === "tool_execution_start") {
      const toolCallId = stringAt(payload, "toolCallId");
      const toolName = stringAt(payload, "toolName");
      if (!toolCallId || !toolName) continue;
      const args = asObject(payload.args);
      calls.set(toolCallId, { toolName, args });
      if (["edit", "write"].includes(toolName)) executionStarted = true;
      if (toolName === "swe_complete") {
        const contractId = stringAt(args, "contractId") ?? activeContractAt(beforeManifest);
        if (contractId) completionAttempts.set(contractId, (completionAttempts.get(contractId) ?? 0) + 1);
      }
      continue;
    }
    if (event.kind !== "tool_execution_end") continue;
    const toolCallId = stringAt(payload, "toolCallId");
    if (!toolCallId) continue;
    const call = calls.get(toolCallId);
    const toolName = stringAt(payload, "toolName") ?? call?.toolName;
    if (toolName === "bash" && call) {
      const command = stringAt(call.args, "command");
      if (command && VERIFICATION_COMMAND.test(command)) {
        const exitCode = toolExitCode(payload);
        const verification = { toolCallId, command, exitCode };
        verificationCommands.push(verification);
        if (exitCode === 0) successfulVerificationSinceCompletion.push(verification);
      }
    }
    if (toolName === "swe_complete" && call) {
      const details = toolDetails(payload);
      const contractId = stringAt(details, "contractId") ?? stringAt(call.args, "contractId") ?? activeContractAt(beforeManifest);
      const status = stringAt(details, "status") ?? (payload.isError === true ? "error" : "unknown");
      if (!contractId) continue;
      completionStatuses.push({ contractId, status });
      if (status === "completed") {
        completionOrder.push(contractId);
        const evidence = successfulVerificationSinceCompletion.at(-1);
        if (evidence) evidenceByContract.set(contractId, evidence);
        successfulVerificationSinceCompletion.length = 0;
      } else if (["blocked", "conflict", "rejected"].includes(status)) {
        blockerResponded = true;
      }
    }
  }

  const findings: string[] = [];
  if (!executionStarted) findings.push("execution-not-started");
  if (!sameArray(completionOrder, expectedOrder)) {
    findings.push(`contract-order:expected=${expectedOrder.join(",")};actual=${completionOrder.join(",")}`);
  }
  const completed = new Set<string>();
  for (const contractId of completionOrder) {
    const missing = (dependencies.get(contractId) ?? []).filter((dependency) => !completed.has(dependency));
    if (missing.length > 0) findings.push(`dependency-bypass:${contractId}:${missing.join(",")}`);
    completed.add(contractId);
  }
  for (const contractId of expectedOrder) {
    if (!hasCompletionRecord(afterIndex, contractId)) {
      findings.push(`verification-evidence-missing:${contractId}`);
      continue;
    }
    if (!hasValidEvidenceChain(afterIndex, input.after, contractId)) findings.push(`evidence-chain-invalid:${contractId}`);
    if (!evidenceByContract.has(contractId)) findings.push(`verification-evidence-missing:${contractId}`);
  }
  let modelCompletionRetries = 0;
  for (const [contractId, attempts] of [...completionAttempts].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (attempts <= 1) continue;
    modelCompletionRetries += attempts - 1;
    findings.push(`completion-retry:${contractId}:${attempts}`);
  }
  for (const completion of completionStatuses) {
    if (completion.status !== "completed") findings.push(`completion-status:${completion.contractId}:${completion.status}`);
  }
  const criticalViolations = findForbiddenCanonicalMutations(input.before, input.after, input.manifestPath, input.contractIndexPath);
  for (const mutation of criticalViolations) findings.push(`immutable-canonical-mutation:${mutation.path}:${mutation.reason}`);
  const finalReconciled = reconciliationObserved && canonicalFinalState(afterManifest, afterIndex, expectedOrder);
  if (!finalReconciled) findings.push("final-reconciliation:canonical state is incomplete or was not reconciled");

  const stableFindings = [...new Set(findings)].sort((a, b) => a.localeCompare(b, "en"));
  const validEvidenceContracts = expectedOrder.filter((contractId) =>
    evidenceByContract.has(contractId) && hasValidEvidenceChain(afterIndex, input.after, contractId));
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    ...input.identity,
    outcome: stableFindings.length === 0 ? "passed" : "failed",
    findings: stableFindings,
    lifecycle: {
      executionStarted,
      expectedContractOrder: expectedOrder,
      completionOrder,
      verificationCommands,
      validEvidenceContracts,
      completionStatuses,
      retries: { modelCompletion: modelCompletionRetries, provider: providerRetries, harness: harnessReruns },
      blockerResponded,
      finalReconciled,
    },
    criticalViolations,
  };
}

export function serializeTrialScore(score: DeterministicTrialScore): string {
  return `${stableStringify(score)}\n`;
}

function executableContracts(index: JsonRecord): Array<{ id: string; dependsOn: string[] }> {
  if (!Array.isArray(index.contracts)) throw new Error("contract index contracts must be an array");
  return index.contracts.flatMap((value) => {
    if (!isObject(value) || value.kind !== "subphase" || typeof value.id !== "string") return [];
    const dependsOn = Array.isArray(value.dependsOn) ? value.dependsOn.filter((item): item is string => typeof item === "string") : [];
    return [{ id: value.id, dependsOn }];
  });
}

function toolExitCode(payload: JsonRecord): number {
  if (payload.isError === true) {
    const reported = numberAt(toolDetails(payload), "exitCode");
    return reported === undefined || reported === 0 ? 1 : reported;
  }
  return numberAt(toolDetails(payload), "exitCode") ?? 0;
}

function toolDetails(payload: JsonRecord): JsonRecord {
  const result = asObject(payload.result);
  return isObject(result.details) ? result.details : isObject(payload.details) ? payload.details : result;
}

function hasCompletionRecord(index: JsonRecord, contractId: string): boolean {
  const records = asObject(index.completionRecords);
  const record = records[contractId];
  if (!isObject(record)) return false;
  const verification = asObject(record.verification);
  const review = asObject(record.review);
  return typeof verification.path === "string" && typeof verification.contentHash === "string"
    && typeof review.path === "string" && typeof review.contentHash === "string" && review.decision === "approve";
}

function hasValidEvidenceChain(index: JsonRecord, snapshot: ScoreSnapshot, contractId: string): boolean {
  const record = asObject(asObject(index.completionRecords)[contractId]);
  const verification = asObject(record.verification);
  const review = asObject(record.review);
  return evidenceHashMatches(snapshot, verification) && evidenceHashMatches(snapshot, review) && review.decision === "approve";
}

function evidenceHashMatches(snapshot: ScoreSnapshot, envelope: JsonRecord): boolean {
  const path = stringAt(envelope, "path");
  const expected = stringAt(envelope, "contentHash");
  if (!path || !expected) return false;
  const content = snapshot.files.get(path);
  return content !== undefined && `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}` === expected;
}

function canonicalFinalState(manifest: JsonRecord, index: JsonRecord, expectedOrder: readonly string[]): boolean {
  if (!FINAL_STATES.has(String(manifest.initiativeState)) || isObject(manifest.activeContract)) return false;
  const contracts = Array.isArray(index.contracts) ? index.contracts : [];
  const statuses = new Map(contracts.flatMap((value) => isObject(value) && typeof value.id === "string" ? [[value.id, value.status]] : []));
  return expectedOrder.every((contractId) => statuses.get(contractId) === "complete" && hasCompletionRecord(index, contractId));
}

function activeContractAt(manifest: JsonRecord): string | undefined {
  return stringAt(asObject(manifest.activeContract), "id");
}

function parseObjectFile(snapshot: ScoreSnapshot, path: string): JsonRecord {
  const content = snapshot.files.get(path);
  if (content === undefined) throw new Error(`snapshot is missing ${path}`);
  const value: unknown = JSON.parse(content);
  if (!isObject(value)) throw new Error(`${path} must contain a JSON object`);
  return value;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringAt(value: JsonRecord, field: string): string | undefined {
  return typeof value[field] === "string" && value[field] ? value[field] : undefined;
}

function numberAt(value: JsonRecord, field: string): number | undefined {
  return typeof value[field] === "number" && Number.isFinite(value[field]) ? value[field] : undefined;
}

function asObject(value: unknown): JsonRecord {
  return isObject(value) ? value : {};
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort((a, b) => a.localeCompare(b, "en")).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

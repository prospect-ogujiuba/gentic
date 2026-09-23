import { contractFingerprint, readyWork, type Initiative, type VerificationEvidence, type WorkItem } from "../domain/initiative.ts";

export const SWE_CONTEXT_TYPE = "gentic.swe.context";
export const SWE_FOCUS_ENTRY_TYPE = "gentic.swe.focus";
export const DEFAULT_CONTEXT_MAX_CHARS = 8_000;

type ContextOptions = { maxChars?: number };
type ContextMessage = { role?: string; customType?: string; content?: unknown };

export function buildSweContextProjection(initiative: Initiative, options: ContextOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
  if (!Number.isSafeInteger(maxChars) || maxChars < 1_000 || maxChars > 8_000) throw new Error("SWE context maxChars must be between 1000 and 8000");
  const current = selectCurrentWork(initiative);
  const criteria = new Map(initiative.acceptanceCriteria.map((item) => [item.id, item.text]));
  const obligations = new Map(initiative.obligations.map((item) => [item.id, item]));
  const workById = new Map(initiative.work.map((item) => [item.id, item]));
  const completed = initiative.work.filter((item) => item.kind !== "phase" && item.status === "complete").length;
  const fingerprint = contractFingerprint(initiative);
  const lines = [
    `[SWE authority: ${initiative.id} · revision ${initiative.revision} · ${initiative.status}]`,
    `Objective: ${initiative.objective}`,
    `Scope in: ${initiative.scope.in.join("; ") || "none"}`,
    `Non-goals: ${initiative.scope.out.join("; ") || "none"}`,
    `Completed work: ${completed} (collapsed; inspect workflow.json or reports on demand).`,
  ];
  if (current) {
    lines.push(`Current leaf: ${current.id} [${current.status}] ${current.title}`);
    const dependencies = (current.dependsOn ?? []).map((id) => {
      const dependency = workById.get(id);
      return `${id} [${dependency?.status ?? "missing"}]`;
    });
    lines.push(`Prerequisites: ${dependencies.join(", ") || "none"}`);
    for (const id of current.criterionIds ?? []) lines.push(`Criterion ${id}: ${criteria.get(id) ?? "missing"}`);
    for (const id of current.obligationIds ?? []) {
      const obligation = obligations.get(id);
      if (!obligation) continue;
      lines.push(`Obligation ${id}: ${obligation.text}`);
      const missing = missingEvidenceKinds(initiative.evidence, current, id, obligation.verification.requiredEvidence ?? ["machine-command"], fingerprint);
      lines.push(`Evidence ${id}: ${missing.length ? `missing current ${missing.join(", ")}` : "current required kinds recorded"}`);
    }
  } else {
    lines.push("Current leaf: none dependency-ready or active.");
  }
  if (initiative.decisions.length) lines.push(`Critical decisions: ${initiative.decisions.slice(-4).map((item) => `${item.id} ${item.text}`).join(" | ")}`);
  if (initiative.risks.length) lines.push(`Critical risks: ${initiative.risks.slice(-4).map((item) => `${item.id} ${item.text}`).join(" | ")}`);
  if (initiative.artifacts.length) lines.push(`Artifacts: ${initiative.artifacts.slice(-8).map((item) => `${item.path} — ${item.summary}`).join(" | ")}`);
  if (initiative.status === "active") {
    lines.push("Repository workflow.json is authoritative. Re-read current revision; session focus never rewinds it. Continue approved routine reversible workflow work without waiting for another prompt. Preserve permission gates and stop for credentials, destructive or irreversible operations, required contract/scope revision, genuine blockers, or authorization not already granted by the user or repository policy.");
  } else {
    lines.push("Repository workflow.json is authoritative. Re-read current revision; session focus never rewinds it. Do not execute paused, draft, complete, or abandoned initiatives.");
  }
  return boundLines(lines, maxChars);
}

export function refreshSweContextMessages<T>(messages: readonly T[], projection: string): T[] {
  const preserved = messages.filter((message) => (message as ContextMessage | null)?.customType !== SWE_CONTEXT_TYPE);
  const current = { role: "custom", customType: SWE_CONTEXT_TYPE, content: projection, display: false };
  return [...preserved, current as unknown as T];
}

export function restoreSweFocus(entries: readonly unknown[]): string | undefined {
  for (const entry of entries.toReversed()) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (value.type !== "custom" || value.customType !== SWE_FOCUS_ENTRY_TYPE || !value.data || typeof value.data !== "object") continue;
    const initiativeId = (value.data as { initiativeId?: unknown }).initiativeId;
    if (typeof initiativeId === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(initiativeId) && initiativeId.length <= 128) return initiativeId;
  }
  return undefined;
}

function selectCurrentWork(initiative: Initiative): WorkItem | undefined {
  const leaves = initiative.work.filter((item) => item.kind !== "phase" && !initiative.work.some((candidate) => candidate.parentId === item.id));
  return leaves.find((item) => item.status === "active")
    ?? leaves.find((item) => item.status === "implemented")
    ?? readyWork(initiative)[0]
    ?? leaves.find((item) => item.status === "blocked");
}

function missingEvidenceKinds(
  evidence: VerificationEvidence[],
  work: WorkItem,
  obligationId: string,
  kinds: readonly string[],
  fingerprint: string,
): string[] {
  return kinds.filter((kind) => !evidence.toReversed().some((item) => item.kind === kind
    && item.workId === work.id
    && item.obligationIds.includes(obligationId)
    && item.outcome === "passed"
    && item.contractFingerprint === fingerprint));
}

function boundLines(lines: string[], maxChars: number): string {
  const suffix = "\n[SWE context truncated; inspect workflow.json on demand.]";
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;
  return `${full.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`.slice(0, maxChars);
}

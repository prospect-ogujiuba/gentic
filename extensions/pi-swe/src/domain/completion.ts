import { snapshotRelevantPaths } from "../app/verification.ts";
import {
  contractFingerprint,
  parseInitiative,
  transitionWork,
  type EvidenceKind,
  type Initiative,
  type MachineCommandEvidence,
  type VerificationEvidence,
} from "./initiative.ts";

export function completionBlockers(initiative: Initiative, workId: string, cwd: string): string[] {
  const work = initiative.work.find((item) => item.id === workId && item.kind !== "phase");
  if (!work) return [`unknown executable work ${workId}`];
  const blockers: string[] = [];
  if (work.status !== "implemented") blockers.push(`work ${workId} must be implemented before completion`);
  if (work.disposition) blockers.push(`work ${workId} is ${work.disposition.kind}, not completable`);
  const fingerprint = contractFingerprint(initiative);
  for (const obligationId of work.obligationIds ?? []) {
    const obligation = initiative.obligations.find((item) => item.id === obligationId)!;
    const required = obligation.verification.requiredEvidence ?? ["machine-command"];
    const accepted = new Map<EvidenceKind, VerificationEvidence>();
    for (const kind of required) {
      const evidence = latestEvidence(initiative.evidence, workId, obligationId, kind);
      if (!evidence) { blockers.push(`missing ${kind} evidence for obligation ${obligationId}`); continue; }
      if (evidence.outcome !== "passed") { blockers.push(`latest ${kind} evidence for obligation ${obligationId} failed`); continue; }
      if (evidence.contractFingerprint !== fingerprint) { blockers.push(`${kind} evidence for ${obligationId} does not match the current contract`); continue; }
      if (evidence.kind === "machine-command" && evidence.source.before.hash !== evidence.source.after.hash) { blockers.push(`verification changed relevant source for obligation ${obligationId}`); continue; }
      const snapshot = evidence.kind === "machine-command" ? evidence.source.after : evidence.source;
      try {
        const current = snapshotRelevantPaths(cwd, snapshot.paths);
        if (current.hash !== snapshot.hash) blockers.push(`stale source evidence for obligation ${obligationId}`);
        else accepted.set(kind, evidence);
      } catch (error) {
        blockers.push(`stale source evidence for obligation ${obligationId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (obligation.verification.sequence === "red-green") {
      const green = accepted.get("machine-command");
      if (green?.kind === "machine-command" && !hasCurrentRedBeforeGreen(initiative.evidence, workId, obligationId, fingerprint, green)) {
        blockers.push(`obligation ${obligationId} requires observed RED before GREEN`);
      }
    }
  }
  return blockers;
}

export function completeWork(initiative: Initiative, workId: string, cwd: string): Initiative {
  const blockers = completionBlockers(initiative, workId, cwd);
  if (blockers.length) throw new Error(`completion blocked: ${blockers.join("; ")}`);
  return transitionWork(parseInitiative(initiative), workId, "complete");
}

export function completeInitiative(initiative: Initiative, cwd: string): Initiative {
  if (initiative.status !== "active") throw new Error(`initiative must be active before completion, not ${initiative.status}`);
  const unfinished = initiative.work.filter((item) => item.kind !== "phase" && item.status !== "complete" && !item.disposition);
  if (unfinished.length) throw new Error(`initiative completion blocked by unfinished work: ${unfinished.map((item) => item.id).join(", ")}`);
  if (initiative.policies?.independentReviewOnCompletion) {
    const fingerprint = contractFingerprint(initiative);
    const review = initiative.evidence.toReversed().find((item) => item.kind === "independent-review");
    if (!review) throw new Error("initiative completion requires independent-review evidence from another interactive session");
    if (review.outcome !== "passed") throw new Error("latest independent-review evidence failed");
    if (review.contractFingerprint !== fingerprint) throw new Error("independent-review evidence does not match the current contract");
    const current = snapshotRelevantPaths(cwd, review.source.paths);
    if (current.hash !== review.source.hash) throw new Error("independent-review evidence is stale");
  }
  return parseInitiative({ ...initiative, status: "complete" });
}

function latestEvidence(evidence: VerificationEvidence[], workId: string, obligationId: string, kind: EvidenceKind): VerificationEvidence | undefined {
  return evidence.toReversed().find((item) => item.kind === kind && item.workId === workId && item.obligationIds.includes(obligationId));
}

function hasCurrentRedBeforeGreen(evidence: VerificationEvidence[], workId: string, obligationId: string, fingerprint: string, green: MachineCommandEvidence): boolean {
  const greenIndex = evidence.indexOf(green);
  return evidence.slice(0, greenIndex).some((item) => item.kind === "machine-command"
    && item.workId === workId
    && item.obligationIds.includes(obligationId)
    && item.contractFingerprint === fingerprint
    && item.outcome === "failed"
    && Date.parse(item.completedAt) <= Date.parse(green.startedAt));
}

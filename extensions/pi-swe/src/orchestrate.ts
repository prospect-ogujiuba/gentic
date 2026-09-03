import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

import { compareContractIds } from "./domain/contract-graph.ts";
import type { PiSweContractState } from "./domain/lifecycle.ts";
import type { InitiativeResolution } from "./planning.ts";

export type OrchestrationArtifactKey = "workOrder" | "plan" | "diagnosis" | "dsaDecision" | "implementation" | "verification" | "review" | "finalHandoff";

export type OrchestrationArtifacts = Partial<Record<OrchestrationArtifactKey, string>>;

export type OrchestrationReadiness = "missing" | "partial" | "complete";

export type InspectOrchestrationArtifactsRequest = {
  cwd: string;
  topic: string;
};

export type InspectOrchestrationArtifactsResult = {
  topic: string;
  readiness: OrchestrationReadiness;
  artifacts: OrchestrationArtifacts;
  missingRequired: OrchestrationArtifactKey[];
};

export type OrchestrationInspector<Result = InspectOrchestrationArtifactsResult> = {
  inspect(request: InspectOrchestrationArtifactsRequest): Result;
};

export type OrchestrationPath = "feature" | "bug" | "dsa" | "finalize";

export type RecommendOrchestrationTransitionRequest = {
  path: OrchestrationPath;
  artifacts: OrchestrationArtifacts;
  riskyChange?: boolean;
};

export type OrchestrationTransitionRecommendation = {
  stage: "diagnose" | "plan" | "dsa-assess" | "tdd" | "implement" | "verify" | "review" | "finalize" | "complete";
  prompt?: string;
  reason: string;
  requiredArtifacts: OrchestrationArtifactKey[];
};

const REQUIRED_ARTIFACTS: OrchestrationArtifactKey[] = ["workOrder", "plan", "implementation", "verification", "finalHandoff"];
const MAX_LEGACY_FILES = 1_000;
const MAX_LEGACY_TOPICS = 100;

const ARTIFACT_LOCATORS: ReadonlyArray<{ key: OrchestrationArtifactKey; roots: string[]; patterns: RegExp[] }> = Object.freeze([
  { key: "workOrder", roots: [".model-artifacts/specs"], patterns: [/work-order|spec|contract/i] },
  { key: "plan", roots: [".model-artifacts/plans", ".model-artifacts/todo"], patterns: [/plan|phase-index|phase|todo/i] },
  { key: "diagnosis", roots: [".model-artifacts/findings"], patterns: [/diagnos|repro|failure/i] },
  { key: "dsaDecision", roots: [".model-artifacts/findings"], patterns: [/dsa|decision|algorithm|data-structure/i] },
  { key: "implementation", roots: [".model-artifacts/logs"], patterns: [/implement|state\.json$/i] },
  { key: "verification", roots: [".model-artifacts/reports"], patterns: [/verif|test|check/i] },
  { key: "review", roots: [".model-artifacts/reports", ".model-artifacts/findings"], patterns: [/review/i] },
  { key: "finalHandoff", roots: [".model-artifacts/reports"], patterns: [/handoff|final/i] },
]);

export const LEGACY_ADOPTION_REQUIREMENTS = Object.freeze([
  "create a schema-v1 canonical manifest",
  "normalize the legacy plan into canonical plan revision r1",
  "validate the contract DAG and applicability",
  "complete plan review",
  "approve the reviewed canonical plan",
] as const);

export type LegacyPlanInspectionResult =
  | {
      readonly sourceMode: "legacy";
      readonly status: "legacy-unverified";
      readonly topic: string;
      readonly planPath: string;
      readonly candidatePaths: readonly string[];
      readonly candidateTopics: readonly string[];
      readonly adoptionRequirements: typeof LEGACY_ADOPTION_REQUIREMENTS;
      readonly nextAction: "adopt-legacy-plan";
      readonly warnings: readonly string[];
    }
  | {
      readonly sourceMode: "legacy";
      readonly status: "not-found";
      readonly topic: string;
      readonly candidatePaths: readonly [];
      readonly candidateTopics: readonly string[];
      readonly warnings: readonly string[];
    };

export class LegacyPlanInspector {
  inspect(request: InspectOrchestrationArtifactsRequest): LegacyPlanInspectionResult {
    const topic = normalizeTopic(request.topic);
    const candidates = this.collectMatchingArtifacts(request.cwd, topic, [".model-artifacts/todo"], [/plan|phase-index|phase|todo/i], "phases");
    if (!candidates.length) return { sourceMode: "legacy", status: "not-found", topic, candidatePaths: [], candidateTopics: [], warnings: [] };
    return {
      sourceMode: "legacy",
      status: "legacy-unverified",
      topic,
      planPath: candidates[0],
      candidatePaths: candidates,
      candidateTopics: [topic],
      adoptionRequirements: LEGACY_ADOPTION_REQUIREMENTS,
      nextAction: "adopt-legacy-plan",
      warnings: [],
    };
  }

  listCandidateTopics(cwd: string): string[] {
    const todoRoot = join(cwd, ".model-artifacts/todo");
    const topics: string[] = [];
    collectLegacyTopics(todoRoot, "", topics);
    return topics
      .filter((topic) => this.inspect({ cwd, topic }).status === "legacy-unverified")
      .sort();
  }

  inspectArtifacts(request: InspectOrchestrationArtifactsRequest): InspectOrchestrationArtifactsResult {
    const topic = normalizeTopic(request.topic);
    const artifacts: OrchestrationArtifacts = {};
    for (const locator of ARTIFACT_LOCATORS) {
      const candidates = this.collectMatchingArtifacts(request.cwd, topic, locator.roots, locator.patterns);
      if (candidates[0]) artifacts[locator.key] = candidates[0];
    }
    const missingRequired = REQUIRED_ARTIFACTS.filter((key) => !artifacts[key]);
    const presentRequired = REQUIRED_ARTIFACTS.length - missingRequired.length;
    const readiness: OrchestrationReadiness = presentRequired === 0 ? "missing" : missingRequired.length === 0 ? "complete" : "partial";
    return { topic, readiness, artifacts, missingRequired };
  }

  private collectMatchingArtifacts(cwd: string, topic: string, roots: string[], patterns: RegExp[], requiredSegment?: string): string[] {
    const candidates: string[] = [];
    for (const root of roots) {
      const relativeRoot = requiredSegment ? posix.join(root, topic, requiredSegment) : posix.join(root, topic);
      const topicRoot = join(cwd, relativeRoot);
      if (existsSync(topicRoot)) collectFiles(topicRoot, relativeRoot, candidates);
    }
    candidates.sort();
    return candidates.filter((candidate) => patterns.some((pattern) => pattern.test(candidate)));
  }
}

const LEGACY_PLAN_INSPECTOR = new LegacyPlanInspector();
const LEGACY_FILESYSTEM_INSPECTOR: OrchestrationInspector = {
  inspect: (request) => LEGACY_PLAN_INSPECTOR.inspectArtifacts(request),
};

export function inspectOrchestrationArtifacts(
  request: InspectOrchestrationArtifactsRequest,
  inspector: OrchestrationInspector = LEGACY_FILESYSTEM_INSPECTOR,
): InspectOrchestrationArtifactsResult {
  return inspector.inspect(request);
}

export type GateAwareOrchestrationStage =
  | "specify"
  | "diagnose"
  | "plan"
  | "dsa-assess"
  | "tdd-plan"
  | "plan-review"
  | "plan-revise"
  | "implement"
  | "verify"
  | "implementation-review"
  | "finalize"
  | "complete"
  | "blocked-handoff";

export type ContractExecutionView = {
  readonly state: PiSweContractState;
  readonly statePath: string;
  readonly implementationPath?: string;
  readonly verificationPath?: string;
  readonly reviewPath?: string;
  readonly verifierAvailable?: boolean;
  readonly retryCount?: number;
  readonly retryBudget?: number;
};

export type FinalHandoffEvidenceView = {
  readonly path: string;
  readonly available: boolean;
  readonly valid: boolean;
  readonly statePath?: string;
};

export type InitiativeBlockerView = {
  readonly statePath: string;
  readonly evidencePaths?: readonly string[];
  readonly remediation: string;
};

export type RecommendGateAwareOrchestrationRequest = {
  readonly resolution: InitiativeResolution;
  readonly contractExecution?: Readonly<Record<string, ContractExecutionView | undefined>>;
  readonly initiativeBlocker?: InitiativeBlockerView;
  readonly finalHandoffEvidence?: FinalHandoffEvidenceView;
};

export type GateAwareOrchestrationRecommendation = {
  readonly stage: GateAwareOrchestrationStage;
  readonly skill?: "swe-plan" | "swe-diagnose" | "swe-dsa" | "swe-tdd" | "swe-review" | "swe-implement" | "swe-verify" | "swe-finalize";
  readonly reason: string;
  readonly requiredReadPaths: readonly string[];
  readonly intendedWriteArtifact?: string;
  readonly blockingReasons: readonly string[];
  readonly activeContract?: { readonly id: string; readonly path: string };
  readonly readyContracts?: { readonly selected: string; readonly others: readonly string[] };
};

const MAX_RECOMMENDATION_ITEMS = 25;

/** Pure, guidance-only recommendation over an already resolved inspection. */
export function recommendGateAwareOrchestration(request: RecommendGateAwareOrchestrationRequest): GateAwareOrchestrationRecommendation {
  const resolution = request.resolution;
  if (resolution.sourceMode === "resolution") {
    return blockedRecommendation(
      resolution.status === "ambiguous" ? "initiative selection is ambiguous" : "no initiative was found",
      [],
      [resolution.remediation, ...resolution.warnings],
    );
  }
  if (resolution.sourceMode === "legacy") {
    if (resolution.status === "not-found") return blockedRecommendation("no canonical or legacy plan was found", [], resolution.warnings);
    return recommendation({
      stage: "plan-review",
      skill: "swe-review",
      reason: "legacy plans require canonical adoption and plan review before implementation",
      requiredReadPaths: [resolution.planPath],
      intendedWriteArtifact: `.model-artifacts/specs/${resolution.topic}/manifest.json`,
      blockingReasons: resolution.adoptionRequirements,
    });
  }

  const inspection = resolution.inspection;
  const manifest = inspection.manifest;
  if (inspection.diagnostics.length) {
    return blockedRecommendation(
      inspection.diagnostics.some((diagnostic) => diagnostic.code === "stale_link") ? "canonical initiative links are stale" : "canonical initiative inspection is invalid",
      [inspection.manifestPath, ...inspection.diagnostics.map((diagnostic) => diagnostic.path)],
      inspection.diagnostics.map((diagnostic) => `${diagnostic.message}; repair ${diagnostic.path}`),
    );
  }
  if (!manifest) return blockedRecommendation("canonical manifest is unavailable", [inspection.manifestPath], [`create or repair ${inspection.manifestPath}`]);

  const baseReads = [inspection.manifestPath, manifest.activeSpec.path];
  const invalidSupplementalPaths = findInvalidSupplementalPaths(request, manifest.topic);
  if (invalidSupplementalPaths.length) {
    return blockedRecommendation(
      "supplemental orchestration evidence contains unsafe or wrong-topic paths",
      baseReads,
      invalidSupplementalPaths.map((path) => `replace unsafe supplemental artifact path: ${path}`),
    );
  }
  if (manifest.initiativeState === "blocked") {
    const blocker = request.initiativeBlocker;
    return blockedRecommendation(
      "the canonical initiative is blocked",
      [...baseReads, ...(blocker ? [blocker.statePath, ...(blocker.evidencePaths ?? [])] : []), ...blockerArtifactPaths(inspection)],
      blocker
        ? [blocker.remediation]
        : [`record blocker evidence and remediation for the blocked initiative in ${inspection.manifestPath}`],
    );
  }
  if (manifest.initiativeState === "intake" || manifest.initiativeState === "specifying") {
    return recommendation({
      stage: "specify",
      skill: "swe-plan",
      reason: "the initiative needs a complete active specification before planning",
      requiredReadPaths: baseReads,
      intendedWriteArtifact: `.model-artifacts/specs/${manifest.topic}/<timestamp>-spec.md`,
      blockingReasons: blockersForGate(inspection, "spec-ready"),
    });
  }
  if (!manifest.activePlan) {
    return recommendation({
      stage: "plan",
      skill: "swe-plan",
      reason: "the active specification needs a canonical plan revision",
      requiredReadPaths: baseReads,
      intendedWriteArtifact: `.model-artifacts/plans/${manifest.topic}/<timestamp>-plan-index-r<revision>.md`,
      blockingReasons: blockersForGate(inspection, "plan-review-ready"),
    });
  }

  const planReads = [...baseReads, manifest.activePlan.path];
  const requiredSpecialists = Object.entries(manifest.specialists).filter(([, entry]) => entry.status === "required");
  const blockedSpecialists = Object.entries(manifest.specialists).filter(([, entry]) => entry.status === "blocked");
  if (blockedSpecialists.length) {
    return blockedRecommendation(
      "specialist assessment is blocked",
      [...planReads, ...blockedSpecialists.flatMap(([, entry]) => entry.findingPath ? [entry.findingPath] : [])],
      blockedSpecialists.map(([id, entry]) => `resolve specialist ${id}${entry.rationale ? `: ${entry.rationale}` : ""}`),
    );
  }
  const specialist = ["diagnosis", "dsa", "tdd"].find((id) => requiredSpecialists.some(([required]) => required === id));
  if (specialist) {
    const stage = specialist === "diagnosis" ? "diagnose" : specialist === "dsa" ? "dsa-assess" : "tdd-plan";
    const skill = specialist === "diagnosis" ? "swe-diagnose" : specialist === "dsa" ? "swe-dsa" : "swe-tdd";
    return recommendation({
      stage,
      skill,
      reason: `required ${specialist} assessment must complete before plan review`,
      requiredReadPaths: planReads,
      intendedWriteArtifact: `.model-artifacts/findings/${manifest.topic}/<timestamp>-${specialist}-finding.md`,
      blockingReasons: blockersForGate(inspection, "plan-review-ready"),
    });
  }
  if (requiredSpecialists.length) {
    return blockedRecommendation(
      "a required specialist has no mapped orchestration skill",
      planReads,
      requiredSpecialists.map(([id]) => `complete specialist ${id} and link its finding before plan review`),
    );
  }

  const planReviewReady = inspection.gateEvaluation?.planReviewReady === true;
  if (!planReviewReady) {
    return recommendation({
      stage: "plan-revise",
      skill: "swe-plan",
      reason: "the active plan must resolve readiness blockers before plan review",
      requiredReadPaths: [...planReads, ...specialistFindingPaths(manifest), ...blockerArtifactPaths(inspection, "plan-review-ready")],
      intendedWriteArtifact: `.model-artifacts/plans/${manifest.topic}/<timestamp>-plan-index-r<next-revision>.md`,
      blockingReasons: blockersForGate(inspection, "plan-review-ready"),
    });
  }

  const approvalReady = inspection.gateEvaluation?.approvalValid === true;
  if (!approvalReady || manifest.initiativeState === "planning" || manifest.initiativeState === "reviewing") {
    return recommendation({
      stage: "plan-review",
      skill: "swe-review",
      reason: "the review-ready active plan requires explicit review and approval before implementation",
      requiredReadPaths: [...planReads, ...specialistFindingPaths(manifest)],
      intendedWriteArtifact: `.model-artifacts/findings/${manifest.topic}/<timestamp>-plan-review.md`,
      blockingReasons: blockersForGate(inspection, "plan-approved"),
    });
  }

  const active = manifest.activeContract;
  const sortedReady = [...inspection.readyIds].sort(compareContractIds);
  const selectedReady = sortedReady[0];
  if (manifest.initiativeState === "finalizing" || manifest.initiativeState === "complete") {
    const approvedDeferrals = new Set(inspection.gateEvaluation?.approvedDeferrals ?? []);
    const undisposedContracts = inspection.contracts
      .filter((contract) => contract.status !== "complete" && !approvedDeferrals.has(contract.id))
      .sort((left, right) => compareContractIds(left.id, right.id));
    if (active || sortedReady.length || undisposedContracts.length) {
      const dispositionIds = [...new Set([...(active ? [active.id] : []), ...sortedReady, ...undisposedContracts.map((contract) => contract.id)])].sort(compareContractIds);
      const dispositionPaths = inspection.contracts.filter((contract) => dispositionIds.includes(contract.id)).map((contract) => contract.path);
      return blockedRecommendation(
        "terminal initiative state has incomplete contract dispositions",
        [...planReads, ...dispositionPaths],
        dispositionIds.map((id) => `complete or record an evidenced approved deferral for contract ${id} before ${manifest.initiativeState}`),
        active,
        selectedReady ? { selected: selectedReady, others: sortedReady.slice(1) } : undefined,
      );
    }
  }
  if (active && selectedReady && active.id !== selectedReady) {
    const lowestReady = inspection.contracts.find((contract) => contract.id === selectedReady);
    return blockedRecommendation(
      "the active contract conflicts with deterministic lowest-ready selection",
      [...planReads, active.path, ...(lowestReady ? [lowestReady.path] : [])],
      [`clear or complete active contract ${active.id}, or repair readiness so lowest ready contract ${selectedReady} is selected`],
      active,
      { selected: selectedReady, others: sortedReady.slice(1) },
    );
  }
  const selectedContract = active ?? (selectedReady ? inspection.contracts.find((contract) => contract.id === selectedReady) : undefined);
  if (!selectedContract) {
    if (inspection.gateEvaluation?.finalizeReady) {
      const handoff = request.finalHandoffEvidence;
      if (manifest.initiativeState === "complete" || manifest.initiativeState === "finalizing") {
        const handoffReads = handoff ? [handoff.path, ...(handoff.statePath ? [handoff.statePath] : [])] : [];
        if (handoff?.available && handoff.valid && isTopicArtifactPath(handoff.path, "reports", manifest.topic)) {
          return recommendation({ stage: "complete", reason: "validated final-handoff evidence and all required contract dispositions are complete", requiredReadPaths: [...planReads, ...handoffReads], blockingReasons: [] });
        }
        return blockedRecommendation(
          "validated final-handoff evidence is required before completion",
          [...planReads, ...handoffReads],
          [handoff ? `restore or validate final-handoff evidence at ${handoff.path}` : `create and validate final-handoff evidence for ${manifest.topic}`],
        );
      }
      return recommendation({ stage: "finalize", skill: "swe-finalize", reason: "all required contracts are complete or approved for deferral", requiredReadPaths: planReads, intendedWriteArtifact: `.model-artifacts/reports/${manifest.topic}/<timestamp>-final-handoff.md`, blockingReasons: blockersForGate(inspection, "finalize-ready") });
    }
    return blockedRecommendation("no contract is ready for deterministic execution", [...planReads, ...blockerArtifactPaths(inspection)], inspection.blockers.map((blocker) => blocker.remediation));
  }

  const contract = inspection.contracts.find((candidate) => candidate.id === selectedContract.id);
  if (!contract) return blockedRecommendation("active contract is not in the active plan revision", planReads, [`repair active contract ${selectedContract.id} in ${inspection.manifestPath}`]);
  const execution = request.contractExecution?.[contract.id];
  const state = execution?.state ?? (contract.status === "in_progress" ? "implementing" : contract.status);
  const contractReads = [...planReads, contract.path, ...(execution ? [execution.statePath] : [])];
  const contractMeta = { activeContract: { id: contract.id, path: contract.path }, readyContracts: selectedReady ? { selected: contract.id, others: inspection.readyIds.filter((id) => id !== contract.id).sort(compareContractIds) } : undefined };

  if (state === "blocked") return blockedRecommendation("the active contract is blocked", contractReads, blockersForContract(inspection, contract.id), contractMeta.activeContract, contractMeta.readyContracts);
  if (execution?.retryBudget !== undefined && (execution.retryCount ?? 0) >= execution.retryBudget) {
    return blockedRecommendation("the active contract exhausted its retry budget", [...contractReads, ...executionEvidencePaths(execution)], [`inspect repeated failure evidence for contract ${contract.id} and decide whether to revise, defer, or stop`], contractMeta.activeContract, contractMeta.readyContracts);
  }
  if (state === "verifying" && execution?.verifierAvailable === false) {
    return blockedRecommendation("no verifier is available for the active contract", [...contractReads, ...executionEvidencePaths(execution)], [`provide a verifier or approve a documented verification gap for contract ${contract.id}`], contractMeta.activeContract, contractMeta.readyContracts);
  }
  if (state === "verifying") return contractRecommendation("verify", "swe-verify", "the active contract requires verification evidence", contractReads, execution, `.model-artifacts/reports/${manifest.topic}/<timestamp>-verification.md`, contractMeta);
  if (state === "reviewing") return contractRecommendation("implementation-review", "swe-review", "verified implementation requires implementation review", contractReads, execution, `.model-artifacts/reports/${manifest.topic}/<timestamp>-implementation-review.md`, contractMeta);
  if (state === "complete" || state === "deferred") {
    return blockedRecommendation("contract disposition and manifest active contract are inconsistent", contractReads, [`clear active contract ${contract.id} and recompute the next ready contract`], contractMeta.activeContract, contractMeta.readyContracts);
  }
  return contractRecommendation("implement", "swe-implement", `contract ${contract.id} is the deterministic next implementation slice`, contractReads, execution, `.model-artifacts/logs/${manifest.topic}/<timestamp>-implementation.md`, contractMeta);
}

function contractRecommendation(
  stage: Extract<GateAwareOrchestrationStage, "implement" | "verify" | "implementation-review">,
  skill: Extract<GateAwareOrchestrationRecommendation["skill"], "swe-implement" | "swe-verify" | "swe-review">,
  reason: string,
  reads: readonly string[],
  execution: ContractExecutionView | undefined,
  write: string,
  meta: Pick<GateAwareOrchestrationRecommendation, "activeContract" | "readyContracts">,
): GateAwareOrchestrationRecommendation {
  return recommendation({ stage, skill, reason, requiredReadPaths: [...reads, ...executionEvidencePaths(execution)], intendedWriteArtifact: write, blockingReasons: [], ...meta });
}

function recommendation(value: GateAwareOrchestrationRecommendation): GateAwareOrchestrationRecommendation {
  return {
    ...value,
    requiredReadPaths: [...new Set(value.requiredReadPaths)].sort().slice(0, MAX_RECOMMENDATION_ITEMS),
    blockingReasons: [...new Set(value.blockingReasons)].sort().slice(0, MAX_RECOMMENDATION_ITEMS),
    ...(value.readyContracts ? { readyContracts: { selected: value.readyContracts.selected, others: value.readyContracts.others.slice(0, MAX_RECOMMENDATION_ITEMS) } } : {}),
  };
}

function blockedRecommendation(
  reason: string,
  reads: readonly string[],
  blockers: readonly string[],
  activeContract?: GateAwareOrchestrationRecommendation["activeContract"],
  readyContracts?: GateAwareOrchestrationRecommendation["readyContracts"],
): GateAwareOrchestrationRecommendation {
  return recommendation({ stage: "blocked-handoff", reason, requiredReadPaths: reads, blockingReasons: blockers.length ? blockers : ["human decision is required before orchestration can continue"], ...(activeContract ? { activeContract } : {}), ...(readyContracts ? { readyContracts } : {}) });
}

function blockersForGate(inspection: Extract<InitiativeResolution, { sourceMode: "canonical" }>["inspection"], gateId: string): string[] {
  return inspection.blockers.filter((blocker) => blocker.gateId === gateId).map((blocker) => blocker.remediation);
}

function blockersForContract(inspection: Extract<InitiativeResolution, { sourceMode: "canonical" }>["inspection"], contractId: string): string[] {
  return inspection.blockers.filter((blocker) => blocker.contractId === contractId).map((blocker) => blocker.remediation);
}

function blockerArtifactPaths(
  inspection: Extract<InitiativeResolution, { sourceMode: "canonical" }>["inspection"],
  gateId?: string,
): string[] {
  return inspection.blockers
    .filter((blocker) => (!gateId || blocker.gateId === gateId) && blocker.artifact?.startsWith(".model-artifacts/"))
    .map((blocker) => blocker.artifact as string);
}

function specialistFindingPaths(manifest: NonNullable<Extract<InitiativeResolution, { sourceMode: "canonical" }>["inspection"]["manifest"]>): string[] {
  return Object.values(manifest.specialists).flatMap((entry) => entry.findingPath ? [entry.findingPath] : []);
}

function executionEvidencePaths(execution: ContractExecutionView | undefined): string[] {
  return execution ? [execution.implementationPath, execution.verificationPath, execution.reviewPath].filter((path): path is string => Boolean(path)) : [];
}

const MODEL_ARTIFACT_KINDS = new Set(["reports", "logs", "specs", "plans", "findings", "todo"]);

function findInvalidSupplementalPaths(request: RecommendGateAwareOrchestrationRequest, topic: string): string[] {
  const candidates = [
    request.initiativeBlocker?.statePath,
    ...(request.initiativeBlocker?.evidencePaths ?? []),
    request.finalHandoffEvidence?.path,
    request.finalHandoffEvidence?.statePath,
    ...Object.values(request.contractExecution ?? {}).flatMap((execution) => execution
      ? [execution.statePath, execution.implementationPath, execution.verificationPath, execution.reviewPath]
      : []),
  ].filter((path): path is string => typeof path === "string");
  return [...new Set(candidates.filter((path) => !isTopicModelArtifactPath(path, topic)))].sort();
}

function isTopicModelArtifactPath(path: string, topic: string): boolean {
  const match = /^\.model-artifacts\/([^/]+)\//.exec(path);
  return Boolean(match && MODEL_ARTIFACT_KINDS.has(match[1]!) && isTopicArtifactPath(path, match[1]!, topic));
}

function isTopicArtifactPath(path: string, kind: string, topic: string): boolean {
  return path.startsWith(`.model-artifacts/${kind}/${topic}/`)
    && !path.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(path)
    && !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

export function recommendOrchestrationTransition(request: RecommendOrchestrationTransitionRequest): OrchestrationTransitionRecommendation {
  const artifacts = request.artifacts;

  if (!artifacts.workOrder) {
    return {
      stage: "plan",
      prompt: "swe-plan",
      reason: "orchestration needs a work order or slice contract before autonomous guidance",
      requiredArtifacts: ["workOrder"],
    };
  }

  if (!artifacts.plan) {
    return {
      stage: "plan",
      prompt: "swe-plan",
      reason: "feature work needs a plan or phase contract before implementation",
      requiredArtifacts: ["plan"],
    };
  }

  if (request.path === "bug" && !artifacts.diagnosis) {
    return {
      stage: "diagnose",
      prompt: "swe-diagnose",
      reason: "bug work needs diagnosis before TDD or implementation",
      requiredArtifacts: ["diagnosis"],
    };
  }

  if (request.path === "dsa" && !artifacts.dsaDecision) {
    return {
      stage: "dsa-assess",
      prompt: "swe-dsa",
      reason: "representation risk needs a DSA decision before implementation",
      requiredArtifacts: ["dsaDecision"],
    };
  }

  if (!artifacts.implementation) {
    return {
      stage: request.path === "bug" ? "tdd" : "implement",
      prompt: request.path === "bug" ? "swe-tdd" : "swe-implement",
      reason: request.path === "bug" ? "diagnosed bug work should prove the next behavior before implementation" : "planned work needs implementation evidence before verification",
      requiredArtifacts: ["implementation"],
    };
  }

  if (!artifacts.verification) {
    return {
      stage: "verify",
      prompt: "swe-verify",
      reason: "implementation cannot advance without verification evidence",
      requiredArtifacts: ["verification"],
    };
  }

  if ((request.riskyChange || request.path === "finalize") && !artifacts.review) {
    return {
      stage: "review",
      prompt: "swe-review",
      reason: "risky verified changes need review before finalization",
      requiredArtifacts: ["review"],
    };
  }

  if (!artifacts.finalHandoff) {
    return {
      stage: "finalize",
      prompt: "swe-finalize",
      reason: "verified work needs a terminal human handoff",
      requiredArtifacts: ["finalHandoff"],
    };
  }

  return {
    stage: "complete",
    reason: "required orchestration artifacts are present",
    requiredArtifacts: [],
  };
}

function collectLegacyTopics(absoluteDir: string, relativeDir: string, topics: string[]): void {
  if (topics.length >= MAX_LEGACY_TOPICS) return;
  try {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (entry.name === "phases" && relativeDir) topics.push(relativeDir);
      else collectLegacyTopics(join(absoluteDir, entry.name), relativeDir ? posix.join(relativeDir, entry.name) : entry.name, topics);
      if (topics.length >= MAX_LEGACY_TOPICS) return;
    }
  } catch {
    return;
  }
}

function collectFiles(absoluteDir: string, relativeDir: string, files: string[]): void {
  if (files.length >= MAX_LEGACY_FILES) return;
  try {
    for (const entry of readdirSync(absoluteDir).sort()) {
      const absolutePath = join(absoluteDir, entry);
      const relativePath = posix.join(relativeDir, entry);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) collectFiles(absolutePath, relativePath, files);
      else if (stat.isFile() && /\.(md|json)$/i.test(entry)) files.push(relativePath);
      if (files.length >= MAX_LEGACY_FILES) return;
    }
  } catch {
    return;
  }
}

function normalizeTopic(topic: string): string {
  const normalized = topic.trim().replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..") || normalized.includes("\\")) throw new Error(`invalid orchestration topic: ${topic}`);
  return normalized;
}

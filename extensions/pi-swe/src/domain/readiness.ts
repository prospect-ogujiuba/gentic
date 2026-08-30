import type { AnalyzeContractGraphResult, ContractId, ContractNode } from "./contract-graph.ts";
import type { InitiativeManifest, InitiativeSpecialistEntry } from "./initiative.ts";

export const READINESS_GATE_IDS = [
  "spec-ready",
  "plan-review-ready",
  "plan-approved",
  "contract-ready",
  "finalize-ready",
] as const;

export type ReadinessGateId = (typeof READINESS_GATE_IDS)[number];

export const CORE_SPECIALIST_IDS = [
  "diagnosis",
  "dsa",
  "tdd",
  "security",
  "migration",
  "performance",
  "accessibility-ux",
  "operations",
  "compatibility",
] as const;

export type CoreSpecialistId = (typeof CORE_SPECIALIST_IDS)[number];
export type ContractApplicability = "applicable" | "not-applicable" | "unresolved";

export type ApprovedDeferral = {
  readonly approved: boolean;
  readonly evidencePath?: string;
};

export type ContractReadinessFacts = {
  readonly entryInputsAvailable: boolean;
  readonly capabilitiesAvailable: boolean;
  readonly applicability: ContractApplicability;
  readonly acceptanceDefined: boolean;
  readonly verificationDefined: boolean;
  readonly deferral?: ApprovedDeferral;
};

export type ArtifactExistenceFacts = Readonly<Record<string, boolean>>;

export type ReadinessGateResult = {
  readonly id: ReadinessGateId;
  readonly ready: boolean;
};

export type ReadinessBlockingReasonCode =
  | "spec-artifact-missing"
  | "plan-missing"
  | "plan-artifact-missing"
  | "specialist-missing"
  | "specialist-incomplete"
  | "specialist-blocked"
  | "specialist-rationale-missing"
  | "specialist-finding-missing"
  | "specialist-finding-artifact-missing"
  | "approval-missing"
  | "approval-stale"
  | "review-evidence-missing"
  | "graph-invalid"
  | "contract-blocked"
  | "contract-revision-stale"
  | "contract-path-invalid"
  | "contract-artifact-missing"
  | "dependency-incomplete"
  | "entry-input-missing"
  | "capability-missing"
  | "applicability-unresolved"
  | "contract-not-applicable"
  | "acceptance-missing"
  | "verification-missing"
  | "contract-incomplete"
  | "deferral-unapproved"
  | "deferral-evidence-missing";

export type ReadinessBlockingReason = {
  readonly code: ReadinessBlockingReasonCode;
  readonly severity: "error" | "warning";
  readonly gateId: ReadinessGateId;
  readonly message: string;
  readonly remediation: string;
  readonly contractId?: ContractId;
  readonly artifact?: string;
};

export type ReduceReadinessRequest = {
  readonly manifest: InitiativeManifest;
  readonly contracts: readonly ContractNode[];
  readonly graph: AnalyzeContractGraphResult;
  readonly artifacts: ArtifactExistenceFacts;
  readonly contractFacts: Readonly<Record<ContractId, ContractReadinessFacts | undefined>>;
  readonly consequentialSpecialists?: readonly string[];
};

export type ReduceReadinessResult = {
  readonly gates: readonly ReadinessGateResult[];
  readonly initiativeReady: boolean;
  readonly planReviewReady: boolean;
  readonly approvalValid: boolean;
  readonly contractReady: boolean;
  readonly finalizeReady: boolean;
  readonly readyContracts: readonly ContractId[];
  readonly approvedDeferrals: readonly ContractId[];
  readonly trivialPlanEligible: boolean;
  readonly blockingReasons: readonly ReadinessBlockingReason[];
};

const GATE_ORDER = new Map<ReadinessGateId, number>(READINESS_GATE_IDS.map((id, index) => [id, index]));
const SEVERITY_ORDER = { error: 0, warning: 1 } as const;

export function reduceReadiness(request: ReduceReadinessRequest): ReduceReadinessResult {
  const reasons: ReadinessBlockingReason[] = [];
  const consequential = new Set(request.consequentialSpecialists ?? []);
  const plan = request.manifest.activePlan;

  if (!exists(request.artifacts, request.manifest.activeSpec.path)) {
    addReason(reasons, {
      code: "spec-artifact-missing",
      gateId: "spec-ready",
      artifact: request.manifest.activeSpec.path,
      message: `active specification artifact is unavailable: ${request.manifest.activeSpec.path}`,
      remediation: `restore or relink the active specification at ${request.manifest.activeSpec.path}`,
    });
  }
  const specReady = !hasGateReasons(reasons, "spec-ready");

  if (!plan) {
    addReason(reasons, {
      code: "plan-missing",
      gateId: "plan-review-ready",
      message: "no active plan revision is linked",
      remediation: "create and link an active plan revision before review",
    });
  } else if (!exists(request.artifacts, plan.path)) {
    addReason(reasons, {
      code: "plan-artifact-missing",
      gateId: "plan-review-ready",
      artifact: plan.path,
      message: `active plan artifact is unavailable: ${plan.path}`,
      remediation: `restore or relink the active plan at ${plan.path}`,
    });
  }

  for (const specialistId of CORE_SPECIALIST_IDS) {
    validateSpecialist(specialistId, request.manifest.specialists[specialistId], consequential, request.artifacts, reasons);
  }
  const planReviewReady = specReady && !hasGateReasons(reasons, "plan-review-ready");

  if (!plan || !("approval" in request.manifest) || request.manifest.approval === undefined) {
    addReason(reasons, {
      code: "approval-missing",
      gateId: "plan-approved",
      artifact: plan?.path,
      message: "the active plan has no approval record",
      remediation: "review and approve the active plan revision with explicit review evidence",
    });
  } else {
    const approval = request.manifest.approval;
    if (
      approval.planRevision !== plan.revision
      || approval.planPath !== plan.path
      || approval.planContentHash !== plan.contentHash
    ) {
      addReason(reasons, {
        code: "approval-stale",
        gateId: "plan-approved",
        artifact: plan.path,
        message: `approval does not match active plan revision ${plan.revision} at ${plan.path}`,
        remediation: `review and approve active plan revision ${plan.revision} at ${plan.path}`,
      });
    }
    if (!exists(request.artifacts, approval.reviewPath)) {
      addReason(reasons, {
        code: "review-evidence-missing",
        gateId: "plan-approved",
        artifact: approval.reviewPath,
        message: `approval review evidence is unavailable: ${approval.reviewPath}`,
        remediation: `restore or relink review evidence at ${approval.reviewPath}`,
      });
    }
  }
  const planApproved = planReviewReady && !hasGateReasons(reasons, "plan-approved");

  const graphReady = new Set<ContractId>();
  if (!request.graph.ok) {
    for (const diagnostic of request.graph.diagnostics) {
      addReason(reasons, {
        code: "graph-invalid",
        gateId: "contract-ready",
        contractId: diagnostic.ids[0],
        message: diagnostic.message,
        remediation: `repair contract graph diagnostic ${diagnostic.code}${diagnostic.ids.length ? ` for ${diagnostic.ids.join(", ")}` : ""}`,
      });
    }
  } else {
    for (const id of request.graph.ready) graphReady.add(id);
  }

  const contractsById = new Map(request.contracts.map((contract) => [contract.id, contract]));
  for (const id of [...graphReady].sort(compareContractIds)) {
    if (!contractsById.has(id)) {
      addReason(reasons, {
        code: "graph-invalid",
        gateId: "contract-ready",
        contractId: id,
        message: `graph ready set references unknown contract ${id}`,
        remediation: `recompute the graph from the active contract set and remove ${id} from stale graph data`,
      });
    }
  }

  const locallyReady: ContractId[] = [];
  for (const contract of [...request.contracts].sort((left, right) => compareContractIds(left.id, right.id))) {
    const before = reasons.length;
    for (const dependencyId of contract.dependsOn) {
      if (contractsById.get(dependencyId)?.status !== "complete") {
        addReason(reasons, {
          code: "dependency-incomplete",
          gateId: "contract-ready",
          contractId: contract.id,
          artifact: contract.path,
          message: `dependency ${dependencyId} is incomplete for contract ${contract.id}`,
          remediation: `complete dependency ${dependencyId} before starting contract ${contract.id}`,
        });
      }
    }
    validateContractLink(contract, plan, request.artifacts, reasons);
    if (contract.status === "complete") continue;
    validateContractExecution(contract, request.contractFacts[contract.id], reasons);
    if (graphReady.has(contract.id) && reasons.length === before) locallyReady.push(contract.id);
  }
  const readyContracts = planApproved ? locallyReady : [];
  const contractReady = planApproved && readyContracts.length > 0;

  const approvedDeferrals: ContractId[] = [];
  for (const contract of [...request.contracts].sort((left, right) => compareContractIds(left.id, right.id))) {
    if (contract.status === "complete") continue;
    const deferral = request.contractFacts[contract.id]?.deferral;
    if (deferral?.approved && deferral.evidencePath && exists(request.artifacts, deferral.evidencePath)) {
      approvedDeferrals.push(contract.id);
      continue;
    }
    if (deferral && !deferral.approved) {
      addReason(reasons, {
        code: "deferral-unapproved",
        gateId: "finalize-ready",
        contractId: contract.id,
        artifact: deferral.evidencePath,
        message: `contract ${contract.id} deferral is not approved`,
        remediation: `approve the deferral for contract ${contract.id} or complete the contract`,
      });
    } else if (deferral?.approved) {
      addReason(reasons, {
        code: "deferral-evidence-missing",
        gateId: "finalize-ready",
        contractId: contract.id,
        artifact: deferral.evidencePath,
        message: `approved deferral evidence is unavailable for contract ${contract.id}`,
        remediation: `link available approval evidence for deferred contract ${contract.id}`,
      });
    } else {
      addReason(reasons, {
        code: "contract-incomplete",
        gateId: "finalize-ready",
        contractId: contract.id,
        artifact: contract.path,
        message: `contract ${contract.id} is incomplete and has no approved deferral`,
        remediation: `complete contract ${contract.id} or record an evidenced approved deferral`,
      });
    }
  }
  const finalizeReady = planApproved
    && request.graph.ok
    && !hasGateReasons(reasons, "finalize-ready")
    && !hasStructuralContractReasons(reasons);

  const onlyContract = request.contracts.length === 1 ? request.contracts[0] : undefined;
  const onlyFacts = onlyContract ? request.contractFacts[onlyContract.id] : undefined;
  const trivialPlanEligible = Boolean(
    onlyContract
      && onlyFacts
      && onlyFacts.applicability === "applicable"
      && onlyFacts.acceptanceDefined
      && onlyFacts.verificationDefined
      && planApproved
      && readyContracts.includes(onlyContract.id),
  );

  reasons.sort(compareReasons);
  return {
    gates: [
      { id: "spec-ready", ready: specReady },
      { id: "plan-review-ready", ready: planReviewReady },
      { id: "plan-approved", ready: planApproved },
      { id: "contract-ready", ready: contractReady },
      { id: "finalize-ready", ready: finalizeReady },
    ],
    initiativeReady: specReady,
    planReviewReady,
    approvalValid: planApproved,
    contractReady,
    finalizeReady,
    readyContracts,
    approvedDeferrals,
    trivialPlanEligible,
    blockingReasons: reasons,
  };
}

function validateSpecialist(
  id: CoreSpecialistId,
  entry: InitiativeSpecialistEntry | undefined,
  consequential: ReadonlySet<string>,
  artifacts: ArtifactExistenceFacts,
  reasons: ReadinessBlockingReason[],
): void {
  if (!entry) {
    addReason(reasons, {
      code: "specialist-missing",
      gateId: "plan-review-ready",
      artifact: id,
      message: `core specialist ${id} has no applicability entry`,
      remediation: `assess specialist ${id} and record complete, not-required, required, or blocked status`,
    });
    return;
  }
  if (entry.status === "required") {
    addReason(reasons, {
      code: "specialist-incomplete",
      gateId: "plan-review-ready",
      artifact: id,
      message: `required specialist ${id} is incomplete`,
      remediation: `complete specialist ${id} or justify why it is not required`,
    });
  } else if (entry.status === "blocked") {
    addReason(reasons, {
      code: "specialist-blocked",
      gateId: "plan-review-ready",
      artifact: id,
      message: `specialist ${id} is blocked${entry.rationale ? `: ${entry.rationale}` : ""}`,
      remediation: `resolve the blocker for specialist ${id} before plan review`,
    });
  } else if (entry.status === "not-required" && !entry.rationale?.trim()) {
    addReason(reasons, {
      code: "specialist-rationale-missing",
      gateId: "plan-review-ready",
      artifact: id,
      message: `specialist ${id} is not required but has no rationale`,
      remediation: `record a non-empty not-required rationale for specialist ${id}`,
    });
  } else if (entry.status === "complete" && consequential.has(id)) {
    if (!entry.findingPath) {
      addReason(reasons, {
        code: "specialist-finding-missing",
        gateId: "plan-review-ready",
        artifact: id,
        message: `consequential specialist ${id} is complete without a finding path`,
        remediation: `link the consequential finding for specialist ${id}`,
      });
    } else if (!exists(artifacts, entry.findingPath)) {
      addReason(reasons, {
        code: "specialist-finding-artifact-missing",
        gateId: "plan-review-ready",
        artifact: entry.findingPath,
        message: `specialist finding is unavailable for ${id}: ${entry.findingPath}`,
        remediation: `restore or relink the ${id} finding at ${entry.findingPath}`,
      });
    }
  }
}

function validateContractLink(
  contract: ContractNode,
  plan: InitiativeManifest["activePlan"],
  artifacts: ArtifactExistenceFacts,
  reasons: ReadinessBlockingReason[],
): void {
  if (!plan || contract.planRevision !== plan.revision) {
    contractReason(reasons, contract, "contract-revision-stale", `contract ${contract.id} does not target the active plan revision`, `regenerate or relink contract ${contract.id} for the active plan revision`);
  }
  if (!plan || !contract.path.startsWith(`${plan.contractRoot}/`)) {
    contractReason(reasons, contract, "contract-path-invalid", `contract ${contract.id} is outside the active contract root`, `move or relink contract ${contract.id} beneath the active contract root`);
  }
  if (!exists(artifacts, contract.path)) {
    contractReason(reasons, contract, "contract-artifact-missing", `contract artifact is unavailable: ${contract.path}`, `restore or relink contract ${contract.id} at ${contract.path}`);
  }
}

function validateContractExecution(
  contract: ContractNode,
  facts: ContractReadinessFacts | undefined,
  reasons: ReadinessBlockingReason[],
): void {
  if (contract.status === "blocked") {
    contractReason(reasons, contract, "contract-blocked", `contract ${contract.id} is blocked`, `resolve the blocker recorded for contract ${contract.id}`);
  }
  if (!facts?.entryInputsAvailable) {
    contractReason(reasons, contract, "entry-input-missing", `entry inputs are incomplete for contract ${contract.id}`, `provide every declared entry input for contract ${contract.id}`);
  }
  if (!facts?.capabilitiesAvailable) {
    contractReason(reasons, contract, "capability-missing", `required capabilities are unavailable for contract ${contract.id}`, `provide or revise required capabilities for contract ${contract.id}`);
  }
  if (!facts || facts.applicability === "unresolved") {
    contractReason(reasons, contract, "applicability-unresolved", `applicability is unresolved for contract ${contract.id}`, `resolve applicability for contract ${contract.id}`);
  } else if (facts.applicability === "not-applicable") {
    contractReason(reasons, contract, "contract-not-applicable", `contract ${contract.id} is not applicable for execution`, `record an approved deferral for contract ${contract.id}`);
  }
  if (!facts?.acceptanceDefined) {
    contractReason(reasons, contract, "acceptance-missing", `acceptance criteria are missing for contract ${contract.id}`, `define acceptance criteria for contract ${contract.id}`);
  }
  if (!facts?.verificationDefined) {
    contractReason(reasons, contract, "verification-missing", `verification is missing for contract ${contract.id}`, `define verification for contract ${contract.id}`);
  }
}

function contractReason(
  reasons: ReadinessBlockingReason[],
  contract: ContractNode,
  code: ReadinessBlockingReasonCode,
  message: string,
  remediation: string,
): void {
  addReason(reasons, { code, gateId: "contract-ready", contractId: contract.id, artifact: contract.path, message, remediation });
}

function addReason(
  reasons: ReadinessBlockingReason[],
  reason: Omit<ReadinessBlockingReason, "severity"> & { readonly severity?: ReadinessBlockingReason["severity"] },
): void {
  reasons.push({ severity: reason.severity ?? "error", ...reason });
}

function exists(artifacts: ArtifactExistenceFacts, path: string): boolean {
  return artifacts[path] === true;
}

function hasGateReasons(reasons: readonly ReadinessBlockingReason[], gateId: ReadinessGateId): boolean {
  return reasons.some((reason) => reason.gateId === gateId && reason.severity === "error");
}

function hasStructuralContractReasons(reasons: readonly ReadinessBlockingReason[]): boolean {
  const structuralCodes = new Set<ReadinessBlockingReasonCode>([
    "graph-invalid",
    "dependency-incomplete",
    "contract-revision-stale",
    "contract-path-invalid",
    "contract-artifact-missing",
  ]);
  return reasons.some((reason) => reason.severity === "error" && structuralCodes.has(reason.code));
}

function compareReasons(left: ReadinessBlockingReason, right: ReadinessBlockingReason): number {
  return SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || GATE_ORDER.get(left.gateId)! - GATE_ORDER.get(right.gateId)!
    || compareOptionalContractIds(left.contractId, right.contractId)
    || left.code.localeCompare(right.code)
    || (left.artifact ?? "").localeCompare(right.artifact ?? "");
}

function compareOptionalContractIds(left: ContractId | undefined, right: ContractId | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return compareContractIds(left, right);
}

function compareContractIds(left: ContractId, right: ContractId): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? -1) - (rightParts[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}

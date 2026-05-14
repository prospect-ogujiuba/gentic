export type DsaEvidence = "measured" | "inferred" | "speculative";
export type DsaConfidence = "high" | "medium" | "low";

export type DsaWorkload = {
  dominantOperations?: string[];
  scale?: string;
  ordering?: string;
  readWriteShape?: string;
  latency?: string;
  memory?: string;
};

export type DsaAssessmentRequest = {
  problemSummary: string;
  currentImplementation: string;
  semanticRequirements?: string[];
  optimizationWishes?: string[];
  workload?: DsaWorkload;
  evidence?: DsaEvidence;
  currentMeetsSemantics?: boolean;
  proposedStructure?: string;
  proposedAlgorithm?: string;
};

export type DsaAssessment = {
  problemSummary: string;
  currentImplementation: string;
  workloadConstraints: string;
  recommendation: string;
  rejectedAlternatives: string[];
  complexityImpact: string;
  memoryTradeoff: string;
  migrationAdvice: string;
  validationPlan: string;
  confidence: DsaConfidence;
  semanticRequirements: string[];
  optimizationWishes: string[];
};

export function assessDsa(request: DsaAssessmentRequest): DsaAssessment {
  const evidence = request.evidence ?? "speculative";
  const semanticRequirements = normalizeList(request.semanticRequirements);
  const optimizationWishes = normalizeList(request.optimizationWishes);
  const proposedStructure = normalizeText(request.proposedStructure, "the simplest adequate idiomatic structure");
  const proposedAlgorithm = normalizeText(request.proposedAlgorithm, "the access pattern that proves useful for the workload");
  const currentMeetsSemantics = request.currentMeetsSemantics !== false;
  const weakOptimizationOnly = currentMeetsSemantics && evidence === "speculative" && semanticRequirements.length === 0;

  return {
    problemSummary: normalizeText(request.problemSummary, "Unspecified DSA decision."),
    currentImplementation: normalizeText(request.currentImplementation, "Current implementation not inspected."),
    workloadConstraints: summarizeWorkload(request.workload),
    recommendation: currentMeetsSemantics
      ? weakOptimizationOnly
        ? "measure first; keep the current implementation until workload evidence justifies a change"
        : `use ${proposedStructure} with ${proposedAlgorithm} only for the evidenced workload`
      : `change to ${proposedStructure} with ${proposedAlgorithm} to satisfy semantic requirements`,
    rejectedAlternatives: currentMeetsSemantics
      ? ["specialized structures without measured need", "broad refactor based only on optimization wishes"]
      : ["keeping a structure that fails required behavior"],
    complexityImpact: weakOptimizationOnly ? "unknown until measured; avoid claiming asymptotic wins without data" : "state before/after complexity at the call sites touched by the slice",
    memoryTradeoff: weakOptimizationOnly ? "no extra memory until measurement supports an index, cache, or alternate representation" : "document extra indexes, caches, allocation, or locality changes before migration",
    migrationAdvice: currentMeetsSemantics ? "prefer no change or the smallest reversible refactor behind existing APIs" : "add focused tests for required behavior, migrate behind existing APIs, and keep a rollback path",
    validationPlan: evidence === "measured" ? "run focused tests and compare the existing benchmark or instrumentation" : "add focused tests and measure the dominant operations before broadening the change",
    confidence: confidenceFor(evidence, currentMeetsSemantics),
    semanticRequirements,
    optimizationWishes,
  };
}

function confidenceFor(evidence: DsaEvidence, currentMeetsSemantics: boolean): DsaConfidence {
  if (!currentMeetsSemantics) return evidence === "speculative" ? "medium" : "high";
  if (evidence === "measured") return "high";
  if (evidence === "inferred") return "medium";
  return "low";
}

function summarizeWorkload(workload: DsaWorkload | undefined): string {
  if (!workload) return "workload not specified; capture dominant operations, scale, ordering, latency, and memory constraints";
  const entries = [
    listEntry("operations", workload.dominantOperations),
    textEntry("scale", workload.scale),
    textEntry("ordering", workload.ordering),
    textEntry("read/write", workload.readWriteShape),
    textEntry("latency", workload.latency),
    textEntry("memory", workload.memory),
  ].filter(Boolean);
  return entries.length ? entries.join("; ") : "workload not specified; measure before changing representation";
}

function listEntry(label: string, value: string[] | undefined): string | undefined {
  const list = normalizeList(value);
  return list.length ? `${label}: ${list.join(", ")}` : undefined;
}

function textEntry(label: string, value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? `${label}: ${text}` : undefined;
}

function normalizeList(value: string[] | undefined): string[] {
  return (value ?? []).map((entry) => entry.trim()).filter(Boolean);
}

function normalizeText(value: string | undefined, fallback: string): string {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized || fallback;
}

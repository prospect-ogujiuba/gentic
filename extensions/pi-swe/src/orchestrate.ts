import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

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

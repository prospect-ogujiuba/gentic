import type { PiSweFact } from "./classify.ts";
import type { PiSweState } from "./state.ts";
import { normalizeSwePath } from "./state.ts";

export type SwePolicySeverity = "advisory";

export type SwePolicyCode = "missing_plan" | "missing_inspection" | "scope_too_broad" | "missing_verification";

export type SwePolicyResult = {
  code: SwePolicyCode;
  severity: SwePolicySeverity;
  message: string;
  nextAction: string;
};

export type PiSwePolicyResult = {
  allowed: true;
  warnings: SwePolicyResult[];
};

export type PiSwePolicyMode = "off" | "advisory" | "enforced";
export type PiSweStageCheckName = "plan" | "read" | "verification" | "scope";

export type SwePolicyConfig = {
  enabled: boolean;
  mode: PiSwePolicyMode;
  stages: Record<PiSweStageCheckName, { enabled: boolean; mode: "advisory" }>;
  surgicalChange: { maxFiles: number };
};

export type EvaluateSwePolicyOptions = {
  config?: SwePolicyConfig;
  state: PiSweState;
  facts?: readonly PiSweFact[];
};

const DEFAULT_DOMAIN_POLICY_CONFIG: SwePolicyConfig = Object.freeze({
  enabled: true,
  mode: "advisory",
  stages: Object.freeze({
    plan: Object.freeze({ enabled: true, mode: "advisory" }),
    read: Object.freeze({ enabled: true, mode: "advisory" }),
    verification: Object.freeze({ enabled: true, mode: "advisory" }),
    scope: Object.freeze({ enabled: true, mode: "advisory" }),
  }),
  surgicalChange: Object.freeze({ maxFiles: 5 }),
});

export function noPolicyChecks(): PiSwePolicyResult {
  return { allowed: true, warnings: [] };
}

export function evaluateSwePolicy(options: EvaluateSwePolicyOptions): PiSwePolicyResult {
  const config = options.config ?? DEFAULT_DOMAIN_POLICY_CONFIG;
  if (!config.enabled || config.mode === "off") return noPolicyChecks();

  const facts = options.facts ?? [];
  const warnings: SwePolicyResult[] = [];

  for (const fact of facts) {
    if (fact.kind !== "code_change") continue;
    if (checkEnabled(config, "plan") && !options.state.activePlan) warnings.push(result("missing_plan", "No active plan before code change.", "Start or assign a SWE plan/todo before editing."));
    if (checkEnabled(config, "read") && needsInspection(fact)) {
      const path = normalizeSwePath(fact.path ?? "");
      if (path && !options.state.inspectedPaths.includes(path)) warnings.push(result("missing_inspection", `Edit targets '${path}' before it was read.`, `Read '${path}' before editing it.`));
    }
  }

  if (checkEnabled(config, "scope")) {
    const changedPaths = normalizedUnique(options.state.changedPaths);
    const maxFiles = config.surgicalChange.maxFiles;
    if (changedPaths.length > maxFiles) {
      warnings.push(result("scope_too_broad", `Changed ${changedPaths.length} files; surgical limit is ${maxFiles}: ${changedPaths.join(", ")}.`, "Narrow the slice or update the plan with the wider scope."));
    }
  }

  if (checkEnabled(config, "verification") && needsVerification(options.state, facts) && options.state.verification.length === 0) {
    warnings.push(result("missing_verification", "No verification evidence before completion/finalization.", "Run focused verification or record why it was not possible."));
  }

  return { allowed: true, warnings };
}

function checkEnabled(config: SwePolicyConfig, check: PiSweStageCheckName): boolean {
  return config.stages[check]?.enabled !== false;
}

function needsInspection(fact: PiSweFact): boolean {
  return fact.kind === "code_change" && fact.writeMode !== "new" && !!fact.path;
}

function needsVerification(state: PiSweState, facts: readonly PiSweFact[]): boolean {
  return state.activeStage === "finalize" || facts.some((fact) => fact.kind === "todo_completion_attempt");
}

function normalizedUnique(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalizeSwePath))];
}

function result(code: SwePolicyCode, message: string, nextAction: string): SwePolicyResult {
  return { code, severity: "advisory", message, nextAction };
}

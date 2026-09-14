export type TokenConfidence = "exact" | "estimated" | "unknown";

export type ContextPressureLevel = "normal" | "warning" | "critical";
export type ContextPressureAvailability = ContextPressureLevel | "unavailable";

export type ContextPressurePolicy = Readonly<{
  warningPercent: number;
  criticalPercent: number;
  hysteresisPercent: number;
  repeatCooldownMs: number;
}>;

export type ContextPressureUsage = {
  tokens?: number;
  contextWindow?: number;
  /** Percentage of the context window already used. */
  percent?: number;
  tokenConfidence: TokenConfidence;
};

export type ContextPressureEvaluation = {
  available: boolean;
  level: ContextPressureAvailability;
  remainingPercent?: number;
  shouldNotify: boolean;
  notification?: "warning" | "critical";
  reason?: "usage-unavailable" | "usage-not-exact" | "usage-invalid";
};

export type ContextPressureState = Readonly<{
  level: ContextPressureLevel;
  warningArmed: boolean;
  criticalArmed: boolean;
  lastNotifiedLevel?: "warning" | "critical";
  lastNotifiedAtMs?: number;
}>;

export type ContextPressureTransition = {
  state: ContextPressureState;
  evaluation: ContextPressureEvaluation;
};

export const DEFAULT_CONTEXT_PRESSURE_POLICY: ContextPressurePolicy = Object.freeze({
  warningPercent: 25,
  criticalPercent: 10,
  hysteresisPercent: 5,
  repeatCooldownMs: 300_000,
});

export function createContextPressureState(): ContextPressureState {
  return Object.freeze({ level: "normal", warningArmed: true, criticalArmed: true });
}

export function evaluateContextPressure(
  usage: ContextPressureUsage | undefined,
  policy: ContextPressurePolicy = DEFAULT_CONTEXT_PRESSURE_POLICY,
): ContextPressureEvaluation {
  if (!usage) return unavailable("usage-unavailable");
  if (usage.tokenConfidence !== "exact") return unavailable("usage-not-exact");

  const remainingPercent = readRemainingPercent(usage);
  if (remainingPercent === undefined) return unavailable("usage-invalid");

  return {
    available: true,
    level: classifyRemaining(remainingPercent, policy),
    remainingPercent,
    shouldNotify: false,
  };
}

export function reduceContextPressure(
  state: ContextPressureState,
  usage: ContextPressureUsage | undefined,
  policy: ContextPressurePolicy = DEFAULT_CONTEXT_PRESSURE_POLICY,
  nowMs = Date.now(),
): ContextPressureTransition {
  const measured = evaluateContextPressure(usage, policy);
  if (!measured.available || measured.remainingPercent === undefined) {
    return { state, evaluation: measured };
  }

  const remaining = measured.remainingPercent;
  const level = applyHysteresis(state.level, remaining, policy);
  const warningArmed = remaining > policy.warningPercent + policy.hysteresisPercent
    ? true
    : state.warningArmed;
  const criticalArmed = remaining > policy.criticalPercent + policy.hysteresisPercent
    ? true
    : state.criticalArmed;

  const notification = level === "critical" && state.level !== "critical" && state.criticalArmed
    ? "critical"
    : level === "warning" && state.level === "normal" && state.warningArmed
      ? "warning"
      : undefined;

  const nextState: ContextPressureState = Object.freeze({
    level,
    warningArmed: notification === "warning" ? false : warningArmed,
    criticalArmed: notification === "critical" ? false : criticalArmed,
    lastNotifiedLevel: notification ?? state.lastNotifiedLevel,
    lastNotifiedAtMs: notification ? nowMs : state.lastNotifiedAtMs,
  });

  return {
    state: nextState,
    evaluation: {
      available: true,
      level,
      remainingPercent: remaining,
      shouldNotify: notification !== undefined,
      notification,
    },
  };
}

function applyHysteresis(
  previous: ContextPressureLevel,
  remaining: number,
  policy: ContextPressurePolicy,
): ContextPressureLevel {
  if (previous === "critical") {
    if (remaining > policy.warningPercent + policy.hysteresisPercent) return "normal";
    if (remaining > policy.criticalPercent + policy.hysteresisPercent) return "warning";
    return "critical";
  }
  if (previous === "warning") {
    if (remaining <= policy.criticalPercent) return "critical";
    if (remaining > policy.warningPercent + policy.hysteresisPercent) return "normal";
    return "warning";
  }
  return classifyRemaining(remaining, policy);
}

function classifyRemaining(remaining: number, policy: ContextPressurePolicy): ContextPressureLevel {
  if (remaining <= policy.criticalPercent) return "critical";
  if (remaining <= policy.warningPercent) return "warning";
  return "normal";
}

function readRemainingPercent(usage: ContextPressureUsage): number | undefined {
  let remaining: number | undefined;
  if (isFinitePercent(usage.percent)) remaining = 100 - usage.percent;
  else if (
    typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0 &&
    typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 &&
    usage.tokens <= usage.contextWindow
  ) {
    remaining = ((usage.contextWindow - usage.tokens) / usage.contextWindow) * 100;
  }
  return remaining !== undefined && isFinitePercent(remaining) ? remaining : undefined;
}

function isFinitePercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function unavailable(reason: ContextPressureEvaluation["reason"]): ContextPressureEvaluation {
  return { available: false, level: "unavailable", shouldNotify: false, reason };
}

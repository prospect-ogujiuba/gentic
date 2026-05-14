export type TddTestLevel = "unit" | "integration" | "end-to-end" | "characterization";

export type TddRequest = {
  behavior: string;
  testLevel?: TddTestLevel;
  legacyOrUnclearBehavior?: boolean;
  hasFailingTest?: boolean;
  productionChangedBeforeRed?: boolean;
  refactorBeforeGreen?: boolean;
};

export type TddAdvice = {
  nextObservableBehavior: string;
  testLevel: TddTestLevel;
  red: string;
  green: string;
  refactor: string;
  verification: string[];
  antiPatterns: string[];
};

export function adviseTdd(request: TddRequest): TddAdvice {
  const behavior = normalizeText(request.behavior, "the next observable behavior");
  const testLevel = request.testLevel ?? (request.legacyOrUnclearBehavior ? "characterization" : "unit");
  const antiPatterns = detectTddAntiPatterns(request);

  return {
    nextObservableBehavior: behavior,
    testLevel,
    red: request.hasFailingTest
      ? `Keep exactly one failing ${testLevel} test focused on: ${behavior}.`
      : `Write one failing ${testLevel} test first for: ${behavior}.`,
    green: `Make the smallest production change that turns only that behavior green.`,
    refactor: `Refactor only after the focused test is green; preserve behavior and keep scope to touched code.`,
    verification: [`focused ${testLevel} test`, "nearby tests for touched code", "broader checks only if integration risk justifies them"],
    antiPatterns,
  };
}

function detectTddAntiPatterns(request: TddRequest): string[] {
  const antiPatterns: string[] = [];
  if (request.productionChangedBeforeRed) antiPatterns.push("production changed before Red");
  if (request.refactorBeforeGreen) antiPatterns.push("refactor before Green");
  if (!request.hasFailingTest) antiPatterns.push("missing failing test or characterization");
  return antiPatterns;
}

function normalizeText(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || fallback;
}

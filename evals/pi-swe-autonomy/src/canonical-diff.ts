export type ScoreSnapshot = {
  readonly files: Map<string, string>;
};

export type CanonicalMutation = {
  readonly path: string;
  readonly kind: "added" | "deleted" | "changed";
  readonly critical: true;
  readonly reason: string;
};

type JsonRecord = Record<string, unknown>;

export function findForbiddenCanonicalMutations(
  before: ScoreSnapshot,
  after: ScoreSnapshot,
  manifestPath: string,
  contractIndexPath: string,
): readonly CanonicalMutation[] {
  const manifestBefore = parseObject(before.files.get(manifestPath), manifestPath);
  const indexBefore = parseObject(before.files.get(contractIndexPath), contractIndexPath);
  const immutablePaths = approvedImmutablePaths(manifestBefore, indexBefore);
  const mutations: CanonicalMutation[] = [];

  for (const path of [...immutablePaths].sort()) {
    const previous = before.files.get(path);
    const current = after.files.get(path);
    if (previous === current) continue;
    mutations.push(mutation(path, previous, current, "approved immutable canonical content changed"));
  }

  compareMutableDocument(before, after, manifestPath, normalizeManifest, mutations);
  compareMutableDocument(before, after, contractIndexPath, normalizeContractIndex, mutations);
  return mutations.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function approvedImmutablePaths(manifest: JsonRecord, index: JsonRecord): Set<string> {
  const paths = new Set<string>();
  const activeSpec = objectAt(manifest, "activeSpec");
  const activePlan = objectAt(manifest, "activePlan");
  addStringPath(paths, activeSpec.path);
  addStringPath(paths, activePlan.path);
  const contracts = Array.isArray(index.contracts) ? index.contracts : [];
  for (const value of contracts) {
    if (isObject(value)) addStringPath(paths, value.path);
  }
  return paths;
}

function compareMutableDocument(
  before: ScoreSnapshot,
  after: ScoreSnapshot,
  path: string,
  normalize: (value: JsonRecord) => JsonRecord,
  mutations: CanonicalMutation[],
): void {
  const previous = before.files.get(path);
  const current = after.files.get(path);
  if (previous === current) return;
  if (previous === undefined || current === undefined) {
    mutations.push(mutation(path, previous, current, "canonical state document was added or deleted"));
    return;
  }
  try {
    const normalizedBefore = stableStringify(normalize(parseObject(previous, path)));
    const normalizedAfter = stableStringify(normalize(parseObject(current, path)));
    if (normalizedBefore !== normalizedAfter) {
      mutations.push(mutation(path, previous, current, "canonical state changed outside the completion allowlist"));
    }
  } catch {
    mutations.push(mutation(path, previous, current, "canonical state is not valid JSON"));
  }
}

function normalizeManifest(value: JsonRecord): JsonRecord {
  const copy = structuredClone(value);
  delete copy.initiativeState;
  delete copy.activeContract;
  delete copy.updatedAt;
  return copy;
}

function normalizeContractIndex(value: JsonRecord): JsonRecord {
  const copy = structuredClone(value);
  if (Array.isArray(copy.contracts)) {
    copy.contracts = copy.contracts.map((contract) => {
      if (!isObject(contract)) return contract;
      const normalized = { ...contract };
      delete normalized.status;
      return normalized;
    });
  }
  delete copy.completionRecords;
  return copy;
}

function mutation(path: string, before: string | undefined, after: string | undefined, reason: string): CanonicalMutation {
  return {
    path,
    kind: before === undefined ? "added" : after === undefined ? "deleted" : "changed",
    critical: true,
    reason,
  };
}

function parseObject(content: string | undefined, path: string): JsonRecord {
  if (content === undefined) throw new Error(`snapshot is missing ${path}`);
  const parsed: unknown = JSON.parse(content);
  if (!isObject(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

function objectAt(value: JsonRecord, field: string): JsonRecord {
  return isObject(value[field]) ? value[field] : {};
}

function addStringPath(paths: Set<string>, value: unknown): void {
  if (typeof value === "string" && value) paths.add(value);
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

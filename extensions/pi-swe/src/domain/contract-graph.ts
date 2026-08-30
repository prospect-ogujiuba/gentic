export type ContractId = string;

export const CONTRACT_STATUSES = ["pending", "in_progress", "blocked", "complete"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export type ContractMetadata = {
  readonly id: ContractId;
  readonly dependsOn: readonly ContractId[];
  readonly planRevision: number;
  readonly path: string;
  readonly status: ContractStatus;
};

export type PhaseContract = ContractMetadata & {
  readonly kind: "phase";
  readonly parentId?: never;
};

export type SubphaseContract = ContractMetadata & {
  readonly kind: "subphase";
  readonly parentId: ContractId;
};

export type ContractNode = PhaseContract | SubphaseContract;
export type ContractGatePredicate = (contract: Readonly<ContractNode>) => boolean;

export type ContractGraphDiagnosticCode =
  | "invalid_id"
  | "kind_mismatch"
  | "parent_mismatch"
  | "duplicate_id"
  | "unknown_dependency"
  | "self_dependency"
  | "cycle";

export type ContractGraphDiagnostic = {
  readonly code: ContractGraphDiagnosticCode;
  readonly ids: readonly ContractId[];
  readonly message: string;
};

export type AnalyzeContractGraphResult =
  | {
      readonly ok: true;
      readonly topologicalOrder: readonly ContractId[];
      readonly ready: readonly ContractId[];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly ContractGraphDiagnostic[];
    };

const PHASE_ID = /^\d{2}$/;
const SUBPHASE_ID = /^\d{2}\.\d{2}$/;

export function analyzeContractGraph(
  contracts: readonly ContractNode[],
  gate: ContractGatePredicate = () => true,
): AnalyzeContractGraphResult {
  const diagnostics = validateContracts(contracts);
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const nodes = new Map<ContractId, ContractNode>();
  const adjacency = new Map<ContractId, ContractId[]>();
  const inDegree = new Map<ContractId, number>();

  for (const contract of contracts) {
    nodes.set(contract.id, contract);
    adjacency.set(contract.id, []);
    inDegree.set(contract.id, contract.dependsOn.length);
  }
  for (const contract of contracts) {
    for (const dependencyId of contract.dependsOn) adjacency.get(dependencyId)!.push(contract.id);
  }

  const zeroInDegree = new ContractIdHeap(compareContractIds);
  for (const [id, degree] of inDegree) {
    if (degree === 0) zeroInDegree.push(id);
  }

  const topologicalOrder: ContractId[] = [];
  while (zeroInDegree.size > 0) {
    const id = zeroInDegree.pop()!;
    topologicalOrder.push(id);
    for (const dependentId of adjacency.get(id)!) {
      const degree = inDegree.get(dependentId)! - 1;
      inDegree.set(dependentId, degree);
      if (degree === 0) zeroInDegree.push(dependentId);
    }
  }

  if (topologicalOrder.length !== nodes.size) {
    const cycleIds = findCycleIds(adjacency).sort(compareContractIds);
    return {
      ok: false,
      diagnostics: [{ code: "cycle", ids: cycleIds, message: `dependency cycle involves: ${cycleIds.join(", ")}` }],
    };
  }

  const ready = [...nodes.values()]
    .filter((contract) =>
      contract.status !== "complete"
      && contract.dependsOn.every((dependencyId) => nodes.get(dependencyId)!.status === "complete")
      && gate(contract))
    .map((contract) => contract.id)
    .sort(compareContractIds);

  return { ok: true, topologicalOrder, ready };
}

function validateContracts(contracts: readonly ContractNode[]): ContractGraphDiagnostic[] {
  const diagnostics: ContractGraphDiagnostic[] = [];
  const idCounts = new Map<ContractId, number>();

  for (const contract of contracts) idCounts.set(contract.id, (idCounts.get(contract.id) ?? 0) + 1);

  for (const [id, count] of idCounts) {
    if (count > 1) diagnostics.push({ code: "duplicate_id", ids: [id], message: `contract ID is duplicated: ${id}` });
  }

  for (const contract of contracts) {
    const isPhaseId = PHASE_ID.test(contract.id);
    const isSubphaseId = SUBPHASE_ID.test(contract.id);
    if (!isPhaseId && !isSubphaseId) {
      diagnostics.push({ code: "invalid_id", ids: [contract.id], message: `contract ID must match NN or NN.NN: ${contract.id}` });
      continue;
    }
    if ((contract.kind === "phase") !== isPhaseId) {
      diagnostics.push({ code: "kind_mismatch", ids: [contract.id], message: `contract kind does not match ID shape: ${contract.id}` });
    }
    if (contract.kind === "subphase") {
      const expectedParent = contract.id.slice(0, 2);
      if (contract.parentId !== expectedParent) {
        diagnostics.push({
          code: "parent_mismatch",
          ids: [contract.id, contract.parentId],
          message: `subphase ${contract.id} must have parent ${expectedParent}, received ${contract.parentId}`,
        });
      }
    }
  }

  const knownIds = new Set(idCounts.keys());
  for (const contract of contracts) {
    for (const dependencyId of contract.dependsOn) {
      if (dependencyId === contract.id) {
        diagnostics.push({ code: "self_dependency", ids: [contract.id], message: `contract cannot depend on itself: ${contract.id}` });
      } else if (!knownIds.has(dependencyId)) {
        diagnostics.push({
          code: "unknown_dependency",
          ids: [contract.id, dependencyId],
          message: `contract ${contract.id} depends on unknown contract ${dependencyId}`,
        });
      }
    }
  }

  return diagnostics.sort(compareDiagnostics);
}

function compareDiagnostics(left: ContractGraphDiagnostic, right: ContractGraphDiagnostic): number {
  const codeOrder = left.code.localeCompare(right.code);
  if (codeOrder !== 0) return codeOrder;
  const length = Math.min(left.ids.length, right.ids.length);
  for (let index = 0; index < length; index += 1) {
    const idOrder = compareContractIds(left.ids[index]!, right.ids[index]!);
    if (idOrder !== 0) return idOrder;
  }
  return left.ids.length - right.ids.length || left.message.localeCompare(right.message);
}

function compareContractIds(left: ContractId, right: ContractId): number {
  const leftIsHierarchical = PHASE_ID.test(left) || SUBPHASE_ID.test(left);
  const rightIsHierarchical = PHASE_ID.test(right) || SUBPHASE_ID.test(right);
  if (!leftIsHierarchical || !rightIsHierarchical) return left.localeCompare(right);

  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return leftParts.length - rightParts.length || left.localeCompare(right);
}

function findCycleIds(adjacency: ReadonlyMap<ContractId, readonly ContractId[]>): ContractId[] {
  let nextIndex = 0;
  const indices = new Map<ContractId, number>();
  const lowLinks = new Map<ContractId, number>();
  const stack: ContractId[] = [];
  const onStack = new Set<ContractId>();
  const cycleIds = new Set<ContractId>();

  const visit = (id: ContractId): void => {
    indices.set(id, nextIndex);
    lowLinks.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);

    for (const dependentId of adjacency.get(id) ?? []) {
      if (!indices.has(dependentId)) {
        visit(dependentId);
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(dependentId)!));
      } else if (onStack.has(dependentId)) {
        lowLinks.set(id, Math.min(lowLinks.get(id)!, indices.get(dependentId)!));
      }
    }

    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: ContractId[] = [];
    let member: ContractId;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    if (component.length > 1) component.forEach((componentId) => cycleIds.add(componentId));
  };

  for (const id of adjacency.keys()) {
    if (!indices.has(id)) visit(id);
  }
  return [...cycleIds];
}

class ContractIdHeap {
  readonly #values: ContractId[] = [];
  readonly #compare: (left: ContractId, right: ContractId) => number;

  constructor(compare: (left: ContractId, right: ContractId) => number) {
    this.#compare = compare;
  }

  get size(): number {
    return this.#values.length;
  }

  push(value: ContractId): void {
    this.#values.push(value);
    let index = this.#values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.#compare(this.#values[parent]!, value) <= 0) break;
      this.#values[index] = this.#values[parent]!;
      index = parent;
    }
    this.#values[index] = value;
  }

  pop(): ContractId | undefined {
    const first = this.#values[0];
    const last = this.#values.pop();
    if (this.#values.length === 0 || last === undefined) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.#values.length) break;
      const right = left + 1;
      const smaller = right < this.#values.length && this.#compare(this.#values[right]!, this.#values[left]!) < 0 ? right : left;
      if (this.#compare(this.#values[smaller]!, last) >= 0) break;
      this.#values[index] = this.#values[smaller]!;
      index = smaller;
    }
    this.#values[index] = last;
    return first;
  }
}

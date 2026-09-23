import { completionBlockers, completeInitiative, completeWork } from "../domain/completion.ts";
import { parseInitiative, readyWork, transitionWork, type Initiative, type WorkItem } from "../domain/initiative.ts";
import { buildSweContextProjection } from "../pi/context.ts";
import { hashInitiativeArtifacts } from "./artifacts.ts";
import { InitiativeStore, type StoredInitiative } from "./store.ts";
import { createModelReviewEvidence, VerificationCollector, type PreparedVerification, type ReviewRequest, type VerificationRequest } from "./verification.ts";

export type IntentionalRevisionRequest = {
  expectedRevision: number;
  expectedHash: string;
  reason: string;
  proposal: unknown;
};

export class SweService {
  #selected?: string;
  #verificationInitiative?: string;
  readonly cwd: string;
  readonly store: InitiativeStore;
  readonly collector: VerificationCollector;

  constructor(cwd: string, store = new InitiativeStore(cwd), collector = new VerificationCollector(cwd)) {
    this.cwd = cwd;
    this.store = store;
    this.collector = collector;
  }

  async create(initiativeId: string, proposal: unknown, signal?: AbortSignal): Promise<StoredInitiative> {
    const stored = await this.store.create(initiativeId, proposal, signal);
    this.#selected = initiativeId;
    return stored;
  }

  status(initiativeId: string): StoredInitiative {
    this.#selected = initiativeId;
    return this.store.read(initiativeId);
  }

  next(initiativeId: string) {
    return readyWork(this.status(initiativeId).initiative)[0];
  }

  async start(initiativeId: string, workId: string): Promise<StoredInitiative> {
    return this.#mutate(initiativeId, `start ${workId}`, (initiative) => ({ ...transitionWork(initiative, workId, "active"), status: "active" }));
  }

  async markImplemented(initiativeId: string, workId: string): Promise<StoredInitiative> {
    return this.#mutate(initiativeId, `mark ${workId} implemented`, (initiative) => transitionWork(initiative, workId, "implemented"));
  }

  async revise(initiativeId: string, request: IntentionalRevisionRequest): Promise<StoredInitiative> {
    if (!request.reason?.trim()) throw new Error("intentional revision requires a rationale");
    return this.store.mutate(initiativeId, {
      expectedRevision: request.expectedRevision,
      expectedHash: request.expectedHash,
      reason: `intentional revision: ${request.reason.trim()}`,
    }, (current) => {
      if (current.status === "complete" || current.status === "abandoned") throw new Error(`historical ${current.status} initiatives are read-only`);
      const proposal = parseInitiative(request.proposal);
      if (proposal.id !== current.id || proposal.kind !== current.kind || proposal.schemaVersion !== current.schemaVersion) throw new Error("initiative identity is immutable");
      if (proposal.status !== current.status) throw new Error("intentional revision cannot replace initiative runtime status");
      if (JSON.stringify(proposal.evidence) !== JSON.stringify(current.evidence)) throw new Error("intentional revision cannot replace evidence history");
      const existingIds = new Set(current.work.map((item) => item.id));
      for (const existing of current.work.filter((item) => item.kind !== "phase")) {
        const proposed = proposal.work.find((item) => item.id === existing.id);
        if (!proposed) throw new Error(`intentional revision cannot remove existing work ${existing.id}`);
        if (proposed.status !== existing.status || JSON.stringify(proposed.disposition) !== JSON.stringify(existing.disposition)) {
          throw new Error(`intentional revision cannot rewind or replace runtime state for work ${existing.id}`);
        }
        if (existing.status === "complete" && workContract(proposed) !== workContract(existing)) {
          throw new Error(`intentional revision cannot rewrite completed work ${existing.id}; add pending follow-up work instead`);
        }
      }
      for (const added of proposal.work.filter((item) => item.kind !== "phase" && !existingIds.has(item.id))) {
        if (added.status !== "pending" || added.disposition) throw new Error(`new work ${added.id} must begin pending without a disposition`);
      }
      return hashInitiativeArtifacts(this.cwd, { ...proposal, revision: current.revision });
    });
  }

  contextProjection(initiativeId: string, options: { maxChars?: number } = {}): string {
    return buildSweContextProjection(this.status(initiativeId).initiative, options);
  }

  prepareVerification(initiativeId: string, request: VerificationRequest): PreparedVerification {
    const prepared = this.collector.prepare(this.status(initiativeId).initiative, request);
    this.#verificationInitiative = initiativeId;
    return prepared;
  }

  observeToolCall(event: { toolCallId: string; toolName: string; input: Record<string, unknown> }, cwd: string): boolean {
    return this.collector.observeToolCall(event, cwd);
  }

  async observeToolResult(event: { toolCallId: string; toolName: string; input?: Record<string, unknown>; isError: boolean; content: Array<{ type: string; text?: string }> }): Promise<StoredInitiative | undefined> {
    const evidence = this.collector.observeToolResult(event);
    if (!evidence || !this.#verificationInitiative) return undefined;
    const initiativeId = this.#verificationInitiative;
    this.#verificationInitiative = undefined;
    return this.#mutate(initiativeId, `record verification ${evidence.id}`, (initiative) => ({ ...initiative, evidence: [...initiative.evidence, evidence] }));
  }

  async recordReview(initiativeId: string, request: ReviewRequest): Promise<StoredInitiative> {
    return this.#mutate(initiativeId, `record model self-review for ${request.workId}`, (initiative) => {
      const evidence = createModelReviewEvidence(this.cwd, initiative, request);
      return { ...initiative, evidence: [...initiative.evidence, evidence] };
    });
  }

  async complete(initiativeId: string, workId?: string): Promise<StoredInitiative> {
    return workId
      ? this.#mutate(initiativeId, `complete ${workId} with current evidence`, (initiative) => completeWork(initiative, workId, this.cwd))
      : this.#mutate(initiativeId, "complete initiative", completeInitiative);
  }

  completionBlockers(initiativeId: string, workId: string): string[] {
    return completionBlockers(this.status(initiativeId).initiative, workId, this.cwd);
  }

  async pause(initiativeId: string): Promise<StoredInitiative> {
    return this.#mutate(initiativeId, "pause initiative", (initiative) => {
      if (initiative.status === "complete" || initiative.status === "abandoned") throw new Error(`cannot pause ${initiative.status} initiative`);
      return { ...initiative, status: "paused" };
    });
  }

  async resume(initiativeId: string): Promise<StoredInitiative> {
    return this.#mutate(initiativeId, "resume initiative", (initiative) => {
      if (initiative.status !== "paused" && initiative.status !== "draft") throw new Error(`cannot resume ${initiative.status} initiative`);
      return { ...initiative, status: "active" };
    });
  }

  hasActiveWork(): boolean {
    if (!this.#selected) return false;
    try { return this.store.read(this.#selected).initiative.work.some((item) => item.status === "active" || item.status === "implemented"); }
    catch { return false; }
  }

  async #mutate(initiativeId: string, reason: string, mutate: (initiative: Initiative) => Initiative): Promise<StoredInitiative> {
    const current = this.status(initiativeId);
    return this.store.mutate(initiativeId, { expectedRevision: current.initiative.revision, expectedHash: current.hash, reason }, mutate);
  }
}

function workContract(item: WorkItem): string {
  const { status: _status, disposition: _disposition, ...contract } = item;
  return JSON.stringify(contract);
}

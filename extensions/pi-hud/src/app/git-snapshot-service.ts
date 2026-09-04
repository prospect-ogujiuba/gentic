import { collectGitStatus, GitCollectionError, type GitCollectorOptions } from "./git-status.ts";
import type { GitSnapshotState, GitStatus } from "../../types.ts";

export type GitCollector = (cwd: string, options: GitCollectorOptions) => Promise<GitStatus | undefined>;

export interface GitSnapshotServiceOptions {
  collector?: GitCollector;
  debounceMs?: number;
  freshnessMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => number;
}

interface LastGood {
  snapshot: GitStatus;
  updatedAt: number;
}

interface PendingRefresh {
  generation: number;
  cwd: string;
  promise: Promise<GitSnapshotState>;
  resolve(state: GitSnapshotState): void;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
}

export class GitSnapshotService {
  private readonly collector: GitCollector;
  private readonly debounceMs: number;
  private readonly freshnessMs: number;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly now: () => number;
  private generation = 0;
  private cwd?: string;
  private disposed = false;
  private lastGood?: LastGood;
  private pending?: PendingRefresh;
  private state: GitSnapshotState = { status: "unavailable", generation: 0 };

  constructor(options: GitSnapshotServiceOptions = {}) {
    this.collector = options.collector ?? collectGitStatus;
    this.debounceMs = options.debounceMs ?? 25;
    this.freshnessMs = options.freshnessMs ?? 1_000;
    this.timeoutMs = options.timeoutMs ?? 800;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
    this.now = options.now ?? Date.now;
  }

  currentGeneration(): number {
    return this.generation;
  }

  isCurrent(generation: number, cwd: string): boolean {
    return !this.disposed && this.generation === generation && this.cwd === cwd;
  }

  hasPendingWork(): boolean {
    return this.pending !== undefined;
  }

  getState(cwd = this.cwd): GitSnapshotState {
    if (!cwd || cwd !== this.cwd) return { status: "unavailable", generation: this.generation };
    if (this.state.status === "fresh" && this.state.updatedAt !== undefined && this.now() - this.state.updatedAt >= this.freshnessMs) {
      return { ...this.state, status: "stale" };
    }
    return this.state;
  }

  reset(cwd: string): void {
    const pending = this.detachPending();
    this.generation += 1;
    this.cwd = cwd;
    this.disposed = false;
    this.lastGood = undefined;
    this.state = { status: "unavailable", generation: this.generation };
    pending?.resolve(this.state);
  }

  dispose(): void {
    const pending = this.detachPending();
    this.generation += 1;
    this.cwd = undefined;
    this.disposed = true;
    this.lastGood = undefined;
    this.state = { status: "unavailable", generation: this.generation };
    pending?.resolve(this.state);
  }

  requestRefresh(cwd: string): Promise<GitSnapshotState> {
    if (this.disposed || this.cwd !== cwd) this.reset(cwd);
    if (this.pending) return this.pending.promise;

    const current = this.getState(cwd);
    if (current.status === "fresh") return Promise.resolve(current);

    const generation = this.generation;
    let resolve!: (state: GitSnapshotState) => void;
    const promise = new Promise<GitSnapshotState>((done) => { resolve = done; });
    const pending: PendingRefresh = { generation, cwd, promise, resolve };
    this.pending = pending;
    this.state = {
      status: "loading",
      generation,
      snapshot: this.lastGood?.snapshot,
      updatedAt: this.lastGood?.updatedAt,
    };
    pending.timer = setTimeout(() => void this.collectPending(pending), Math.max(0, this.debounceMs));
    return promise;
  }

  private detachPending(): PendingRefresh | undefined {
    const pending = this.pending;
    this.pending = undefined;
    if (pending?.timer) clearTimeout(pending.timer);
    pending?.controller?.abort(new Error("Git snapshot generation ended"));
    return pending;
  }

  private async collectPending(pending: PendingRefresh): Promise<void> {
    pending.timer = undefined;
    const controller = new AbortController();
    pending.controller = controller;

    try {
      const snapshot = await this.collector(pending.cwd, {
        signal: controller.signal,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
      });
      if (!this.canPublish(pending)) return;

      if (snapshot) {
        const updatedAt = this.now();
        this.lastGood = { snapshot, updatedAt };
        this.state = { status: "fresh", generation: pending.generation, snapshot, updatedAt };
      } else {
        this.lastGood = undefined;
        this.state = { status: "unavailable", generation: pending.generation, updatedAt: this.now() };
      }
    } catch (error) {
      if (!this.canPublish(pending)) return;
      const detail = error instanceof GitCollectionError
        ? { code: error.code, message: error.message }
        : { code: "command-failure", message: error instanceof Error ? error.message.slice(0, 200) : "Git collection failed" };
      this.state = this.lastGood
        ? { status: "stale", generation: pending.generation, snapshot: this.lastGood.snapshot, updatedAt: this.lastGood.updatedAt, error: detail }
        : { status: "error", generation: pending.generation, updatedAt: this.now(), error: detail };
    } finally {
      if (this.pending === pending) this.pending = undefined;
      pending.resolve(this.getState(pending.cwd));
    }
  }

  private canPublish(pending: PendingRefresh): boolean {
    return !this.disposed
      && this.pending === pending
      && this.generation === pending.generation
      && this.cwd === pending.cwd;
  }
}

export const gitSnapshotService = new GitSnapshotService();

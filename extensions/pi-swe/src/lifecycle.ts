import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertStableArtifactPath,
  buildNextAction,
  normalizeArtifactPath,
  parseAutonomousState,
  type ReconstructedAutonomousWorkState,
  type ReconstructAutonomousWorkStateRequest,
  type StableWorkDocumentKey,
} from "./domain/lifecycle.ts";

// Compatibility shim: domain extraction moved pure lifecycle rules to ./domain/lifecycle.ts.
export * from "./domain/lifecycle.ts";

export function reconstructAutonomousWorkState(request: ReconstructAutonomousWorkStateRequest): ReconstructedAutonomousWorkState {
  const statePath = normalizeArtifactPath(request.statePath);
  assertStableArtifactPath(statePath);
  assertReadableArtifact(request.cwd, statePath);

  const state = parseAutonomousState(readFileSync(join(request.cwd, statePath), "utf8"));
  const artifactPaths: Record<string, string> = { state: statePath };

  const activePhase = state.activePhase ? normalizeArtifactPath(state.activePhase) : undefined;
  if (activePhase) {
    assertStableArtifactPath(activePhase);
    assertReadableArtifact(request.cwd, activePhase);
    artifactPaths.activePhase = activePhase;
  }

  for (const [key, value] of Object.entries(state.artifacts ?? {}) as Array<[StableWorkDocumentKey, string | undefined]>) {
    if (!value) continue;
    const artifactPath = normalizeArtifactPath(value);
    assertStableArtifactPath(artifactPath);
    assertReadableArtifact(request.cwd, artifactPath);
    artifactPaths[key] = artifactPath;
  }

  return {
    topic: state.topic,
    state: state.state,
    artifactPaths,
    nextAction: buildNextAction(state.state, artifactPaths),
  };
}

function assertReadableArtifact(cwd: string, filePath: string): void {
  if (!existsSync(join(cwd, filePath))) throw new Error(`missing artifact: ${filePath}`);
}

import { createHash } from "node:crypto";

import type { ArtifactInventory, ArtifactInventoryEntry } from "./types.ts";

export type MigrationMove = {
  source: string;
  destination: string;
  sourceHash: string;
  bytes: number;
  reason: string;
};

export type MigrationPlanBlocker = {
  code: "inventory-diagnostic" | "unsafe-entry" | "missing-identity" | "destination-exists" | "duplicate-destination" | "no-moves";
  source: string;
  message: string;
};

export type MigrationPlan = {
  schemaVersion: 1;
  generatedAt: string;
  projectRoot: string;
  configPath: string | null;
  configFingerprint: string;
  moves: MigrationMove[];
  blockers: MigrationPlanBlocker[];
  eligible: boolean;
  fingerprint: string;
};

export type CreateMigrationPlanOptions = {
  generatedAt?: string;
  configFingerprint: string;
};

export function createMigrationPlan(inventory: ArtifactInventory, options: CreateMigrationPlanOptions): MigrationPlan {
  const moves: MigrationMove[] = [];
  const blockers: MigrationPlanBlocker[] = inventory.diagnostics.map((message) => ({
    code: "inventory-diagnostic",
    source: ".model-artifacts",
    message,
  }));
  const sources = new Set(inventory.entries.map((entry) => entry.source));
  for (const entry of inventory.entries) {
    if (entry.classification === "legacy-movable") {
      if (!entry.destination || !entry.contentHash) {
        blockers.push({ code: "missing-identity", source: entry.source, message: "movable entry lacks destination or content hash" });
        continue;
      }
      if (sources.has(entry.destination) && entry.destination !== entry.source) {
        blockers.push({ code: "destination-exists", source: entry.source, message: `destination already exists: ${entry.destination}` });
      }
      moves.push({
        source: entry.source,
        destination: entry.destination,
        sourceHash: entry.contentHash,
        bytes: entry.bytes,
        reason: entry.reasons.join(","),
      });
      continue;
    }
    if (isUnsafeLegacyEntry(entry)) {
      blockers.push({ code: "unsafe-entry", source: entry.source, message: entry.reasons.join(", ") || entry.classification });
    }
  }
  moves.sort((a, b) => a.source.localeCompare(b.source) || a.destination.localeCompare(b.destination));
  const byDestination = new Map<string, MigrationMove[]>();
  for (const move of moves) {
    const group = byDestination.get(move.destination) ?? [];
    group.push(move);
    byDestination.set(move.destination, group);
  }
  for (const [destination, group] of [...byDestination].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length < 2) continue;
    for (const move of group) {
      blockers.push({ code: "duplicate-destination", source: move.source, message: `multiple sources target ${destination}` });
    }
  }
  if (moves.length === 0) blockers.push({ code: "no-moves", source: ".model-artifacts", message: "no eligible legacy Markdown artifacts were found" });
  blockers.sort((a, b) => a.source.localeCompare(b.source) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  const logical = {
    schemaVersion: 1 as const,
    projectRoot: inventory.projectRoot,
    configPath: inventory.configPath,
    configFingerprint: options.configFingerprint,
    moves,
    blockers,
  };
  return {
    ...logical,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    eligible: blockers.length === 0,
    fingerprint: fingerprint(logical),
  };
}

export function isNoopMigrationPlan(plan: MigrationPlan): boolean {
  return plan.moves.length === 0 && plan.blockers.length === 1 && plan.blockers[0]?.code === "no-moves";
}

export function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
}

function isUnsafeLegacyEntry(entry: ArtifactInventoryEntry): boolean {
  if (entry.classification === "ambiguous" && entry.source.endsWith(".md")) return true;
  if (entry.classification === "protected" && entry.reasons.some((reason) => reason.startsWith("inbound-reference:"))) return true;
  if (entry.classification === "invalid" && entry.reasons.some((reason) => reason === "symlink-not-followed" || reason === "unsupported-filesystem-entry")) return true;
  return false;
}

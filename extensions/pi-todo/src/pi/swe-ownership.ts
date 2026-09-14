import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const MAX_WORKFLOWS = 100;
const MAX_DIRECTORIES = 1_000;
const MAX_BYTES = 512 * 1024;

/** pi-swe owns tool lifecycle while one of its tasks is actively executing. */
export function hasActiveSweWorkflow(cwd: string): boolean {
  const root = resolve(cwd, ".model-artifacts/initiatives");
  try { if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return false; } catch { return false; }
  let inspected = 0;
  let directories = 0;
  function walk(directory: string, depth: number): boolean {
    directories += 1;
    if (depth > 16 || inspected >= MAX_WORKFLOWS || directories > MAX_DIRECTORIES) return false;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isFile() && entry.name === "workflow.json") {
        inspected += 1;
        try {
          const stat = statSync(path);
          if (stat.size > MAX_BYTES) continue;
          const value = JSON.parse(readFileSync(path, "utf8"));
          if (isActiveWorkflow(value)) return true;
        } catch { /* malformed workflows do not weaken normal todo enforcement */ }
      } else if (entry.isDirectory() && walk(path, depth + 1)) return true;
    }
    return false;
  }
  return walk(root, 0);
}

function isActiveWorkflow(value: unknown): boolean {
  if (!record(value) || value.version !== 1 || value.status !== "active" || typeof value.topic !== "string" || typeof value.goal !== "string"
    || !Number.isSafeInteger(value.revision) || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
    || typeof value.activeTask !== "string" || !Array.isArray(value.tasks)) return false;
  return value.tasks.some((task) => {
    if (!record(task) || task.id !== value.activeTask || task.status !== "active" || task.assessmentStatus !== "assessed"
      || !Array.isArray(task.approaches) || !record(task.approachReasons)) return false;
    const reasons = task.approachReasons;
    if (task.approaches.some((approach) => typeof approach !== "string" || typeof reasons[approach] !== "string" || !(reasons[approach] as string).trim())) return false;
    const checkpoint = task.verificationCheckpoint;
    return record(checkpoint) && Number.isSafeInteger(checkpoint.revision) && (checkpoint.revision as number) >= 1
      && (checkpoint.revision as number) <= (value.revision as number) && typeof checkpoint.at === "string" && Number.isFinite(Date.parse(checkpoint.at));
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

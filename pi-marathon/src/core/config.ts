import path from "node:path";
import type { MarathonConfig } from "./types.js";
import { clamp, deepMerge, readJsonFile, uniqueStrings } from "./util.js";

export const DEFAULT_CONFIG: MarathonConfig = {
  scheduler: { pollIntervalMs: 750, maxConcurrency: 2, maxResearchConcurrency: 2, leaseSeconds: 180 },
  budget: { maxTasks: 60, maxAgentCalls: 120, maxRunMinutes: 720, maxCostUsd: null, maxFinalAuditCycles: 3 },
  task: { maxAttempts: 3, timeoutMinutes: 45, criticAfterFailures: 2 },
  planner: { maxTasks: 30 },
  verification: { commands: [], commandTimeoutMs: 600_000, requireAgentVerdict: true },
  workspace: { mode: "auto", requireCleanGit: true, keepOnComplete: true },
  git: { commitPassedTasks: true, branchPrefix: "marathon/" },
  models: {
    planner: { thinking: "high" }, worker: { thinking: "high" }, verifier: { thinking: "high" },
    critic: { thinking: "high" }, auditor: { thinking: "high" },
  },
  safety: {
    allowNetwork: true,
    blockedCommandPatterns: [
      "rm\\s+-rf\\s+/(?:\\s|$)", "(?:^|\\s)sudo(?:\\s|$)",
      "(?:^|\\s)(?:shutdown|reboot|halt|poweroff)(?:\\s|$)",
      "(?:^|\\s)(?:mkfs|fdisk|diskpart)(?:\\s|$)", "git\\s+push\\s+.*--force",
      "curl\\s+[^|]+\\|\\s*(?:sh|bash)", "wget\\s+[^|]+\\|\\s*(?:sh|bash)"
    ],
    allowedExternalPaths: [],
  },
};

export function normalizeConfig(input: MarathonConfig): MarathonConfig {
  input.scheduler.pollIntervalMs = clamp(input.scheduler.pollIntervalMs, 250, 30_000);
  input.scheduler.maxConcurrency = Math.floor(clamp(input.scheduler.maxConcurrency, 1, 16));
  input.scheduler.maxResearchConcurrency = Math.floor(clamp(input.scheduler.maxResearchConcurrency, 1, 16));
  input.scheduler.leaseSeconds = Math.floor(clamp(input.scheduler.leaseSeconds, 30, 3600));
  input.budget.maxTasks = Math.floor(clamp(input.budget.maxTasks, 1, 500));
  input.budget.maxAgentCalls = Math.floor(clamp(input.budget.maxAgentCalls, 1, 2000));
  input.budget.maxRunMinutes = Math.floor(clamp(input.budget.maxRunMinutes, 1, 43_200));
  input.budget.maxFinalAuditCycles = Math.floor(clamp(input.budget.maxFinalAuditCycles, 1, 20));
  if (input.budget.maxCostUsd !== null) input.budget.maxCostUsd = clamp(input.budget.maxCostUsd, 0, 100_000);
  input.task.maxAttempts = Math.floor(clamp(input.task.maxAttempts, 1, 20));
  input.task.timeoutMinutes = Math.floor(clamp(input.task.timeoutMinutes, 1, 1440));
  input.task.criticAfterFailures = Math.floor(clamp(input.task.criticAfterFailures, 1, 20));
  input.planner.maxTasks = Math.floor(clamp(input.planner.maxTasks, 1, input.budget.maxTasks));
  input.verification.commandTimeoutMs = clamp(input.verification.commandTimeoutMs, 1000, 3_600_000);
  input.verification.commands = uniqueStrings(input.verification.commands, 50);
  input.safety.blockedCommandPatterns = uniqueStrings(input.safety.blockedCommandPatterns, 100);
  input.safety.allowedExternalPaths = uniqueStrings(input.safety.allowedExternalPaths, 100).map((item) => path.resolve(item));
  input.git.branchPrefix = input.git.branchPrefix.trim() || "marathon/";
  return input;
}

export async function loadConfig(projectCwd: string, agentDir: string, overrides?: Partial<MarathonConfig>): Promise<MarathonConfig> {
  let config = structuredClone(DEFAULT_CONFIG);
  const globalConfig = await readJsonFile<Partial<MarathonConfig>>(path.join(agentDir, "marathon", "config.json"));
  const projectConfig = await readJsonFile<Partial<MarathonConfig>>(path.join(projectCwd, ".pi", "marathon.json"));
  if (globalConfig) config = deepMerge(config, globalConfig);
  if (projectConfig) config = deepMerge(config, projectConfig);
  if (overrides) config = deepMerge(config, overrides);
  return normalizeConfig(config);
}

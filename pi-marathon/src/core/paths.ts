import os from "node:os";
import path from "node:path";
import { canonicalPath, sha256 } from "./util.js";
export const defaultAgentDir = (): string => process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
export async function resolveProjectStateDir(agentDir: string, projectCwd: string): Promise<string> {
  const canonical = await canonicalPath(projectCwd);
  return path.join(agentDir, "marathon", "projects", sha256(canonical).slice(0, 20));
}
export const daemonInfoPath = (stateDir: string): string => path.join(stateDir, "daemon.json");
export const daemonLockPath = (stateDir: string): string => path.join(stateDir, "daemon.lock");
export const daemonLogPath = (stateDir: string): string => path.join(stateDir, "daemon.log");
export const databasePath = (stateDir: string): string => path.join(stateDir, "marathon.db");
export const workspaceBasePath = (stateDir: string): string => path.join(stateDir, "workspaces");

import path from "node:path";
import type { MarathonConfig } from "./types.js";

export interface PolicyDecision { allowed: boolean; reason?: string }

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class CommandPolicy {
  readonly workspaceRoot: string;
  readonly safety: MarathonConfig["safety"];
  private readonly patterns: RegExp[];

  constructor(workspaceRoot: string, safety: MarathonConfig["safety"]) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.safety = safety;
    this.patterns = safety.blockedCommandPatterns.map((pattern) => new RegExp(pattern, "i"));
  }

  checkCommand(command: string): PolicyDecision {
    const normalized = command.trim();
    if (!normalized) return { allowed: false, reason: "Empty shell command" };
    for (const pattern of this.patterns) if (pattern.test(normalized)) return { allowed: false, reason: `Blocked command pattern: ${pattern.source}` };
    if (!this.safety.allowNetwork && /(?:^|[;&|\s])(?:curl|wget|ssh|scp|rsync|nc|ncat|telnet|ftp|npm\s+(?:install|view)|pnpm\s+(?:add|install)|yarn\s+add|pip\s+install)(?:\s|$)/i.test(normalized)) {
      return { allowed: false, reason: "Network-capable commands are disabled for this run" };
    }
    if (/(?:^|[;&|\s])(?:rm|mv|cp|chmod|chown|truncate|dd|tee)(?:\s|$)/i.test(normalized)) {
      const absoluteTargets = normalized.match(/(?:^|\s)(\/(?:[^\s'";|]+)|[A-Za-z]:\\[^\s'";|]+)/g) ?? [];
      for (const match of absoluteTargets) {
        const target = path.resolve(match.trim());
        if (!inside(target, this.workspaceRoot) && !this.safety.allowedExternalPaths.some((root) => inside(target, root))) {
          return { allowed: false, reason: `Mutation outside workspace is blocked: ${target}` };
        }
      }
    }
    return { allowed: true };
  }

  checkPath(input: string, operation: "read" | "write"): PolicyDecision {
    const candidate = path.resolve(this.workspaceRoot, input);
    const allowed = inside(candidate, this.workspaceRoot) || this.safety.allowedExternalPaths.some((root) => inside(candidate, root));
    if (!allowed) return { allowed: false, reason: `${operation} outside workspace is blocked: ${candidate}` };
    if (operation === "write") {
      const relative = path.relative(this.workspaceRoot, candidate).replaceAll("\\", "/");
      if (/(^|\/)\.git(?:\/|$)|(^|\/)node_modules(?:\/|$)/.test(relative)) return { allowed: false, reason: `Protected path: ${relative}` };
      if (/(^|\/)\.env(?:\.|$)/.test(relative)) return { allowed: false, reason: `Secret-bearing environment file is protected: ${relative}` };
    }
    return { allowed: true };
  }
}

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { LoadedConfig } from "../config/index.ts";
import type { Decision, Request } from "../domain/policy.ts";

function redactedCommand(command: string): string {
  return command
    .replace(/((?:api[_-]?key|token|password|authorization)\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .slice(0, 8192);
}

export function appendAudit(ctx: ExtensionContext, req: Request, d: Decision, config: LoadedConfig): void {
  if (!config.audit.enabled || !config.audit.path) return;
  const path = resolve(ctx.cwd, config.audit.path);
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...req, command: redactedCommand(req.command), decision: d }) + "\n";
  if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > config.audit.maxBytes) {
    const rotated = `${path}.1`;
    try { renameSync(path, rotated); } catch { /* a concurrent writer may already have rotated it */ }
  }
  appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
}

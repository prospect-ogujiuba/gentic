import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { LoadedConfig } from "./config.ts";
import type { Decision, Request } from "./policy.ts";

export function appendAudit(ctx: ExtensionContext, req: Request, d: Decision, config: LoadedConfig): void {
  if (!config.audit.enabled || !config.audit.path) return;
  const path = resolve(ctx.cwd, config.audit.path);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...req, decision: d }) + "\n");
}

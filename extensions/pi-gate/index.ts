import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export { defaultConfig, getConfig, getConfigPaths, globalConfigPath, loadConfig, projectConfigPathForCwd, readConfigJson, SCHEMA_URL, type Config, type LoadedConfig } from "./src/config.ts";
export { BUILTIN_PERMISSIONS, decideWithConfig, mergePermissions, normalizeCommand, patternRegex, rulesFromPermissions, type Action, type Decision, type PermissionChoice, type Permissions, type Remember, type Request, type Rule, type Source } from "./src/policy.ts";
export { appendAudit } from "./src/audit.ts";
export { getSessionDecision, persistGlobalRule, persistProjectRule, persistRule, projectConfigPath, rememberSessionDecision } from "./src/remember.ts";
export { promptPermission } from "./src/ui/prompt.ts";
export { decide, gate, registerPiGate } from "./src/pi/register.ts";

import { registerPiGate } from "./src/pi/register.ts";

export default function piGate(pi: ExtensionAPI): void {
  registerPiGate(pi);
}

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionState, PermissionsReadyEvent, PermissionsService } from "@gotgenes/pi-permission-system";
import { createHash } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

export type PermissionsServiceLocator = (sessionId: string) => PermissionsService | undefined | Promise<PermissionsService | undefined>;
export type BridgeDecision = { state: PermissionState; matchedPattern?: string };
export type UserBashPolicyAnalyzer = (permissions: PermissionsService, command: string, cwd: string) => Promise<BridgeDecision>;
export type BridgeReviewOutcome = "allow" | "deny" | "approved" | "rejected" | "service_unavailable" | "analysis_error";
export type BridgeReviewRecord = { command: string; state: PermissionState; outcome: BridgeReviewOutcome };
export type BridgeReviewContext = { cwd: string; projectTrusted: boolean };
export type BridgeReviewRecorder = (record: BridgeReviewRecord, context: BridgeReviewContext) => Promise<void>;

function blocked(reason: string) {
  return { result: { output: `pi-permission-system: ${reason}`, exitCode: 126, cancelled: false, truncated: false } };
}

async function defaultLocator(sessionId: string): Promise<PermissionsService | undefined> {
  const { getPermissionsService } = await import("@gotgenes/pi-permission-system");
  return getPermissionsService(sessionId);
}

function destructiveRootRemoval(command: string): boolean {
  const normalized = command.trim().replace(/["']/g, "").replace(/[ \t]+/g, " ");
  const rm = normalized.match(/(?:^|\s)rm\s+(.+)$/i);
  if (!rm) return false;
  const tokens = rm[1]!.split(/\s+/);
  const options = tokens.filter((token) => token.startsWith("-"));
  const operands = tokens.filter((token) => !token.startsWith("-"));
  const recursive = options.some((option) => option === "--recursive" || /^-[^-]*r/i.test(option));
  const force = options.some((option) => option === "--force" || /^-[^-]*f/i.test(option));
  const home = (process.env.HOME ?? "").replace(/\/+$/, "");
  return recursive && force && operands.some((operand) => {
    const canonical = operand.replace(/\/+$/, "") || "/";
    return canonical === "/" || canonical === "~" || canonical === "$HOME" || canonical === "${HOME}" || (home !== "" && canonical === home);
  });
}

export function bridgeReviewEntry(record: BridgeReviewRecord) {
  return {
    timestamp: new Date().toISOString(),
    extension: "pi-permission-bridge",
    event: "permission_request.user_bash_bridge",
    source: "user_bash",
    surface: "bash",
    state: record.state,
    outcome: record.outcome,
    commandLength: record.command.length,
    commandSha256: createHash("sha256").update(record.command).digest("hex"),
  };
}

const permissionInternal = (relativePath: string): Promise<any> => import(new URL(`../../node_modules/@gotgenes/pi-permission-system/src/${relativePath}`, import.meta.url).href);

async function configuredReviewLogging(path: string): Promise<boolean | undefined> {
  try {
    const { loadUnifiedConfig } = await permissionInternal("config-loader.ts");
    const loaded = loadUnifiedConfig(path) as { config?: { permissionReviewLog?: unknown }; issues?: unknown[] };
    if ((loaded.issues?.length ?? 0) > 0) return undefined;
    const setting = loaded.config?.permissionReviewLog;
    return typeof setting === "boolean" ? setting : undefined;
  } catch {
    return undefined;
  }
}

export async function appendBridgeReview(record: BridgeReviewRecord, context: BridgeReviewContext, agentDir = getAgentDir()): Promise<void> {
  const configDir = join(agentDir, "extensions", "pi-permission-system");
  const globalSetting = await configuredReviewLogging(join(configDir, "config.json"));
  const projectSetting = context.projectTrusted
    ? await configuredReviewLogging(join(context.cwd, ".pi", "extensions", "pi-permission-system", "config.json"))
    : undefined;
  if ((projectSetting ?? globalSetting ?? true) === false) return;

  const logsDir = join(configDir, "logs");
  const logPath = join(logsDir, "pi-permission-system-permission-review.jsonl");
  try {
    await mkdir(logsDir, { recursive: true, mode: 0o700 });
    await chmod(logsDir, 0o700);
    const handle = await open(logPath, "a", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.appendFile(`${JSON.stringify(bridgeReviewEntry(record))}\n`, "utf8");
    } finally {
      await handle.close();
    }
  } catch {
    // Review logging must not turn an allow/deny decision into a runtime failure.
  }
}

function mostRestrictive(decisions: BridgeDecision[]): BridgeDecision {
  const rank: Record<PermissionState, number> = { allow: 0, ask: 1, deny: 2 };
  return decisions.reduce((worst, decision) => rank[decision.state] > rank[worst.state] ? decision : worst, { state: "allow" });
}

/** Async full-bash analysis matching the provider's command, path, and external-directory surfaces. */
export async function analyzeUserBashCommand(permissions: PermissionsService, command: string, cwd: string): Promise<BridgeDecision> {
  if (destructiveRootRemoval(command)) return { state: "deny", matchedPattern: "<destructive-root-removal>" };

  const [{ BashProgram }, { PathNormalizer }, { pathFlavorForPlatform }, { capabilitySurfaceForEffect }] = await Promise.all([
    permissionInternal("access-intent/bash/program.ts"),
    permissionInternal("path-normalizer.ts"),
    permissionInternal("path/path-flavor.ts"),
    permissionInternal("access-intent/path-surfaces.ts"),
  ]);
  const normalizer = new PathNormalizer(pathFlavorForPlatform(process.platform), cwd);
  const program = await BashProgram.parse(command, normalizer);
  const decisions: BridgeDecision[] = [permissions.checkPermission("bash", command)];
  const commandUnits = program.commands();
  if (command.trim() && commandUnits.length === 0) decisions.push({ state: "ask", matchedPattern: "<unparseable-bash-command>" });
  for (const unit of commandUnits) {
    const decision = permissions.checkPermission("bash", unit.text);
    decisions.push(unit.wrapperKind && decision.state === "allow"
      ? { state: "ask", matchedPattern: unit.wrapperKind === "opaque-payload" ? "<opaque-bash-wrapper>" : "<indirection-bash-wrapper>" }
      : decision);
  }

  for (const { path, effect } of program.pathRuleCandidates()) {
    const surface = capabilitySurfaceForEffect("path", effect.effect);
    for (const value of path.matchValues()) decisions.push(permissions.checkPermission(surface, value));
  }
  for (const { path, effect } of program.externalAccesses()) {
    const surface = capabilitySurfaceForEffect("external_directory", effect.effect);
    for (const value of path.matchValues()) decisions.push(permissions.checkPermission(surface, value));
  }

  return mostRestrictive(decisions);
}

async function confirmAsk(ctx: ExtensionContext, command: string): Promise<boolean> {
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return false;
  try {
    const first = await ctx.ui.confirm("Permission required", `Run user bash command?\n\n${command}`, { timeout: 30_000 });
    if (!first) return false;
    return await ctx.ui.confirm("Confirm permission", "Confirm this user bash command a second time.", { timeout: 30_000 });
  } catch {
    return false;
  }
}

/** Preserve policy enforcement for Pi's user_bash path, which is outside tool_call. */
export function registerUserBashPermissionBridge(
  pi: ExtensionAPI,
  locate: PermissionsServiceLocator = defaultLocator,
  analyze: UserBashPolicyAnalyzer = analyzeUserBashCommand,
  recordReview: BridgeReviewRecorder = appendBridgeReview,
): void {
  let service: Promise<PermissionsService | undefined> | undefined;
  const recordSafely = async (record: BridgeReviewRecord, context: BridgeReviewContext) => { try { await recordReview(record, context); } catch {} };

  pi.events.on("permissions:ready", (raw) => {
    const { sessionId } = raw as PermissionsReadyEvent;
    service = sessionId ? Promise.resolve(locate(sessionId)).catch(() => undefined) : undefined;
  });

  pi.on("session_shutdown", () => { service = undefined; });
  pi.on("user_bash", async (event, ctx) => {
    const cwd = event.cwd || ctx.cwd;
    const reviewContext = { cwd, projectTrusted: ctx.isProjectTrusted?.() ?? false };
    const permissions = await service;
    if (!permissions) {
      await recordSafely({ command: event.command, state: "deny", outcome: "service_unavailable" }, reviewContext);
      return blocked("permission service unavailable");
    }
    let decision: BridgeDecision;
    try {
      decision = await analyze(permissions, event.command, cwd);
    } catch {
      await recordSafely({ command: event.command, state: "deny", outcome: "analysis_error" }, reviewContext);
      return blocked("permission analysis failed");
    }
    if (decision.state === "allow") {
      await recordSafely({ command: event.command, state: "allow", outcome: "allow" }, reviewContext);
      return;
    }
    if (decision.state === "deny") {
      await recordSafely({ command: event.command, state: "deny", outcome: "deny" }, reviewContext);
      return blocked("denied by policy");
    }
    const approved = await confirmAsk(ctx, event.command);
    await recordSafely({ command: event.command, state: approved ? "allow" : "deny", outcome: approved ? "approved" : "rejected" }, reviewContext);
    return approved ? undefined : blocked("user bash confirmation denied or unavailable");
  });
}

export default function piPermissionBridge(pi: ExtensionAPI): void {
  registerUserBashPermissionBridge(pi);
}

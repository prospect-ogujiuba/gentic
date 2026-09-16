import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RUNNER_PROTOCOL_VERSION,
  reportKindForRole,
  toolsForRole,
  type ChildRunConfig,
  type RawRunnerReport,
  type RunnerToolName,
} from "./runner-protocol.ts";
import { scopeAllowsPath, type Clarification, type Finding, type RunLease, type RunnerRole, type StageReport } from "./workflow.ts";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MAX_PACKET_BYTES = 256 * 1024;
const MAX_INSTRUCTIONS = 16;
const MAX_RESOURCES = 16;
const MAX_SCOPE = 64;
const MAX_BOOTSTRAP_COMMANDS = 8;
const MAX_TAIL = 8_192;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const RETRYABLE_FAILURES = new Set<RunnerFailureCode>(["spawn-error", "nonzero-exit", "premature-exit", "model-error"]);

export type ResolvedPiCli = { entrypoint: string; packageRoot: string; version: string };
export type RunnerBudgets = { timeoutMs: number; maxTurns: number; maxOutputBytes: number; maxRetries: number; killGraceMs: number };
export type BootstrapCommand = { command: string; args: string[]; cwd?: string; timeoutMs: number; env?: Record<string, string> };
export type AgentRunRequest = {
  role: RunnerRole;
  runId: string;
  actorId: string;
  lease: RunLease;
  cwd: string;
  provider: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  projectInstructions: string[];
  approvedSkills?: string[];
  trustedExtensions?: string[];
  contractPacket: { hash: string; payload: unknown };
  snapshotPacket?: { hash: string; payload: unknown };
  clarificationAnswers?: Array<{ id: string; question: string; answer: string; answeredBy?: string; answeredAt?: string }>;
  readScope: string[];
  writeScope?: string[];
  budgets: RunnerBudgets;
  bootstrap?: BootstrapCommand[];
  agentSourceDir?: string;
};

export type EffectiveRunnerConfig = {
  piVersion: string;
  piEntrypoint: string;
  provider: string;
  model: string;
  thinking: AgentRunRequest["thinking"];
  role: RunnerRole;
  cwd: string;
  tools: RunnerToolName[];
  skillHashes: Array<{ path: string; hash: string }>;
  extensionHashes: Array<{ path: string; hash: string }>;
  packetHash: string;
  freshSession: true;
  discoveryDisabled: true;
  childTestsAreAdvisory: true;
  trustBoundary: "capability-scoped tools and worktrees are not an OS sandbox";
};

export type RunnerFailureCode =
  | "invalid-request"
  | "spawn-error"
  | "malformed-event"
  | "malformed-report"
  | "missing-report"
  | "premature-exit"
  | "model-error"
  | "model-mismatch"
  | "credentials-unavailable"
  | "nonzero-exit"
  | "deadline"
  | "cancelled"
  | "turn-limit"
  | "output-limit"
  | "bootstrap-failed"
  | "bootstrap-isolation";

export type RunnerFailure = { code: RunnerFailureCode; message: string; retryable: boolean; exitCode?: number; stdoutTail?: string; stderrTail?: string };
export type RunnerResult =
  | { ok: true; report: StageReport; effectiveConfig: EffectiveRunnerConfig; attempts: number }
  | { ok: false; failure: RunnerFailure; effectiveConfig?: EffectiveRunnerConfig; attempts: number };

export type RunnerInvocation = {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  systemPrompt: string;
  effectiveConfig: EffectiveRunnerConfig;
};

type InvocationDependencies = { pi: ResolvedPiCli; childExtensionPath: string; agentDir: string; configPath: string; baseEnvironment?: NodeJS.ProcessEnv };
type AgentRunnerOptions = {
  pi?: ResolvedPiCli;
  childExtensionPath?: string;
  baseEnvironment?: NodeJS.ProcessEnv;
  now?: () => Date;
};

type ClassifiedOutcome = { ok: true; report: StageReport } | { ok: false; failure: RunnerFailure };

type ProcessOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  events: unknown[];
  forcedCode?: RunnerFailureCode;
  spawnError?: Error;
};

export function resolvePinnedPiCli(): ResolvedPiCli {
  const entry = fileURLToPath(import.meta.resolve(PACKAGE_NAME));
  let directory = dirname(entry);
  for (;;) {
    const packagePath = join(directory, "package.json");
    if (existsSync(packagePath)) {
      const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string; version?: string; bin?: string | Record<string, string> };
      if (manifest.name === PACKAGE_NAME) {
        const relativeBin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
        if (!relativeBin || typeof manifest.version !== "string") throw new Error("installed Pi package has no CLI/version metadata");
        const entrypoint = realpathSync(resolve(directory, relativeBin));
        if (!statSync(entrypoint).isFile()) throw new Error("installed Pi CLI entry point is not a file");
        return { entrypoint, packageRoot: realpathSync(directory), version: manifest.version };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("could not resolve the installed Pi package root");
    directory = parent;
  }
}

export function buildRunnerInvocation(request: AgentRunRequest, dependencies: InvocationDependencies): RunnerInvocation {
  validateRequest(request);
  const childExtension = trustedFile(dependencies.childExtensionPath, "runner child extension");
  const skills = (request.approvedSkills ?? []).map((path) => trustedFile(path, "approved skill"));
  const extensions = (request.trustedExtensions ?? []).map((path) => trustedFile(path, "trusted provider extension"));
  const tools = toolsForRole(request.role);
  const packet: ChildRunConfig["packet"] = {
    contract: request.contractPacket,
    ...(request.snapshotPacket ? { snapshot: request.snapshotPacket } : {}),
    clarificationAnswers: request.clarificationAnswers ?? [],
  };
  const packetText = stableJson(packet);
  if (Buffer.byteLength(packetText) > MAX_PACKET_BYTES) throw new Error(`runner packet exceeds ${MAX_PACKET_BYTES} bytes`);
  const systemPrompt = roleSystemPrompt(request, packetText);
  const effectiveConfig: EffectiveRunnerConfig = {
    piVersion: dependencies.pi.version,
    piEntrypoint: dependencies.pi.entrypoint,
    provider: request.provider,
    model: request.model,
    thinking: request.thinking,
    role: request.role,
    cwd: realpathSync(request.cwd),
    tools,
    skillHashes: skills.map((path) => ({ path, hash: fileHash(path) })),
    extensionHashes: [childExtension, ...extensions].map((path) => ({ path, hash: fileHash(path) })),
    packetHash: hash(packetText),
    freshSession: true,
    discoveryDisabled: true,
    childTestsAreAdvisory: true,
    trustBoundary: "capability-scoped tools and worktrees are not an OS sandbox",
  };
  const flags = [
    "--mode", "json", "--print", "--no-session", "--offline",
    "--no-extensions", "--extension", childExtension,
    ...extensions.flatMap((path) => ["--extension", path]),
    "--no-skills", ...skills.flatMap((path) => ["--skill", path]),
    "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools",
    "--tools", tools.join(","),
    "--provider", request.provider, "--model", request.model, "--thinking", request.thinking,
    "--system-prompt", systemPrompt,
    "Complete the assigned role from the immutable packet and terminate with runner_report.",
  ];
  return {
    command: process.execPath,
    args: [dependencies.pi.entrypoint, ...flags],
    environment: {
      ...(dependencies.baseEnvironment ?? process.env),
      PI_CODING_AGENT_DIR: dependencies.agentDir,
      PI_SWE_RUN_CONFIG: dependencies.configPath,
      PI_OFFLINE: "1",
    },
    systemPrompt,
    effectiveConfig,
  };
}

export class AgentRunner {
  readonly pi: ResolvedPiCli;
  readonly childExtensionPath: string;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly now: () => Date;

  constructor(options: AgentRunnerOptions = {}) {
    this.pi = options.pi ?? resolvePinnedPiCli();
    this.childExtensionPath = options.childExtensionPath ?? fileURLToPath(new URL("./runner-child.ts", import.meta.url));
    this.baseEnvironment = options.baseEnvironment ?? process.env;
    this.now = options.now ?? (() => new Date());
  }

  async run(request: AgentRunRequest, options: { signal?: AbortSignal } = {}): Promise<RunnerResult> {
    try { validateRequest(request); }
    catch (error) { return { ok: false, failure: failure("invalid-request", errorMessage(error), false), attempts: 0 }; }
    const isolation = dependencyIsolationFailure(request.cwd);
    if (isolation) return { ok: false, failure: failure("bootstrap-isolation", isolation, false), attempts: 0 };
    const bootstrapFailure = await runBootstrap(request, options.signal);
    if (bootstrapFailure) return { ok: false, failure: bootstrapFailure, attempts: 0 };
    const afterBootstrap = dependencyIsolationFailure(request.cwd);
    if (afterBootstrap) return { ok: false, failure: failure("bootstrap-isolation", afterBootstrap, false), attempts: 0 };

    let latest: RunnerResult | undefined;
    for (let attempt = 1; attempt <= request.budgets.maxRetries + 1; attempt += 1) {
      if (options.signal?.aborted) return { ok: false, failure: failure("cancelled", "agent run was cancelled before launch", false), attempts: attempt - 1 };
      latest = await this.runAttempt(request, attempt, options.signal);
      if (latest.ok || !latest.failure.retryable || attempt > request.budgets.maxRetries) return latest;
    }
    return latest ?? { ok: false, failure: failure("spawn-error", "runner did not launch", true), attempts: 0 };
  }

  private async runAttempt(request: AgentRunRequest, attempt: number, signal?: AbortSignal): Promise<RunnerResult> {
    const root = mkdtempSync(join(tmpdir(), `pi-swe-agent-${safeFragment(request.runId)}-`));
    const agentDir = join(root, "agent");
    const configPath = join(root, "run-config.json");
    mkdirSync(agentDir, { mode: 0o700 });
    try {
      copyAgentCredentials(request.agentSourceDir ?? defaultAgentSourceDir(), agentDir);
      const invocation = buildRunnerInvocation(request, {
        pi: this.pi,
        childExtensionPath: this.childExtensionPath,
        agentDir,
        configPath,
        baseEnvironment: this.baseEnvironment,
      });
      const config: ChildRunConfig = {
        version: RUNNER_PROTOCOL_VERSION,
        role: request.role,
        cwd: realpathSync(request.cwd),
        agentDir,
        provider: request.provider,
        model: request.model,
        thinking: request.thinking,
        readScope: request.readScope,
        writeScope: request.writeScope ?? [],
        tools: invocation.effectiveConfig.tools,
        packet: {
          contract: request.contractPacket,
          ...(request.snapshotPacket ? { snapshot: request.snapshotPacket } : {}),
          clarificationAnswers: request.clarificationAnswers ?? [],
        },
      };
      const configText = `${JSON.stringify(config)}\n`;
      writeFileSync(configPath, configText, { mode: 0o600, flag: "wx" });
      chmodSync(configPath, 0o400);
      invocation.environment.PI_SWE_RUN_CONFIG_HASH = hash(configText);
      const startedAt = this.now().toISOString();
      const outcome = await executeProcess(invocation, request.budgets, signal);
      const completedAt = this.now().toISOString();
      const classified = classifyOutcome(outcome, request, startedAt, completedAt);
      if (classified.ok) return { ok: true, report: classified.report, effectiveConfig: invocation.effectiveConfig, attempts: attempt };
      return { ok: false, failure: classified.failure, effectiveConfig: invocation.effectiveConfig, attempts: attempt };
    } catch (error) {
      return { ok: false, failure: failure("spawn-error", errorMessage(error), true), attempts: attempt };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function validateRequest(request: AgentRunRequest): void {
  if (!request || !["plan-reviewer", "implementer", "general-reviewer", "concern-reviewer", "final-reviewer"].includes(request.role)) throw new Error("invalid runner role");
  boundedId(request.runId, "run id");
  boundedId(request.actorId, "actor id");
  if (request.lease.runId !== request.runId || !request.lease.id || !Number.isSafeInteger(request.lease.fence) || request.lease.fence < 1) throw new Error("run request does not match its lease");
  boundedId(request.provider, "provider");
  boundedId(request.model, "model");
  if (!THINKING_LEVELS.has(request.thinking)) throw new Error("invalid thinking level");
  const cwd = realpathSync(request.cwd);
  if (!statSync(cwd).isDirectory()) throw new Error("runner cwd must be a directory");
  if (!HASH.test(request.contractPacket.hash)) throw new Error("invalid contract packet hash");
  if (request.snapshotPacket && !HASH.test(request.snapshotPacket.hash)) throw new Error("invalid snapshot packet hash");
  if (["general-reviewer", "concern-reviewer", "final-reviewer"].includes(request.role) && !request.snapshotPacket) throw new Error(`${request.role} requires an exact snapshot packet`);
  const reviewFiles = ["general-reviewer", "concern-reviewer", "final-reviewer"].includes(request.role) ? validateReviewSnapshotPayload(request.snapshotPacket!.payload) : [];
  if (!Array.isArray(request.projectInstructions) || !request.projectInstructions.length || request.projectInstructions.length > MAX_INSTRUCTIONS) throw new Error("project instructions must be explicitly provided");
  request.projectInstructions.forEach((item) => boundedText(item, "project instruction", 8_192));
  if (!Array.isArray(request.readScope) || !request.readScope.length || request.readScope.length > MAX_SCOPE) throw new Error("runner requires an explicit read scope");
  request.readScope.forEach(validateScope);
  if (reviewFiles.some((path) => !request.readScope.some((scope) => scopeAllowsPath(scope, path)))) throw new Error("review snapshot contains a relevant file outside the explicit read scope");
  const writeScope = request.writeScope ?? [];
  if (writeScope.length > MAX_SCOPE) throw new Error("runner write scope is too large");
  writeScope.forEach(validateScope);
  if (request.role === "implementer" && !writeScope.length) throw new Error("implementer requires an explicit write scope");
  if (request.role !== "implementer" && writeScope.length) throw new Error("review roles cannot receive write capability");
  if ((request.approvedSkills?.length ?? 0) > MAX_RESOURCES || (request.trustedExtensions?.length ?? 0) > MAX_RESOURCES) throw new Error("too many explicit runner resources");
  if ((request.clarificationAnswers?.length ?? 0) > 32) throw new Error("too many clarification answers");
  for (const clarification of request.clarificationAnswers ?? []) {
    boundedId(clarification.id, "clarification id");
    boundedText(clarification.question, "clarification question", 2_048);
    boundedText(clarification.answer, "clarification answer", 2_048);
    if (clarification.answeredBy !== undefined) boundedId(clarification.answeredBy, "clarification answerer");
    if (clarification.answeredAt !== undefined && !Number.isFinite(Date.parse(clarification.answeredAt))) throw new Error("invalid clarification answer timestamp");
  }
  const budgets = request.budgets;
  if (!Number.isSafeInteger(budgets.timeoutMs) || budgets.timeoutMs < 10 || budgets.timeoutMs > 60 * 60_000) throw new Error("invalid runner deadline budget");
  if (!Number.isSafeInteger(budgets.maxTurns) || budgets.maxTurns < 1 || budgets.maxTurns > 100) throw new Error("invalid runner turn budget");
  if (!Number.isSafeInteger(budgets.maxOutputBytes) || budgets.maxOutputBytes < 512 || budgets.maxOutputBytes > 16 * 1024 * 1024) throw new Error("invalid runner output budget");
  if (!Number.isSafeInteger(budgets.maxRetries) || budgets.maxRetries < 0 || budgets.maxRetries > 2) throw new Error("invalid infrastructure retry budget");
  if (!Number.isSafeInteger(budgets.killGraceMs) || budgets.killGraceMs < 10 || budgets.killGraceMs > 10_000) throw new Error("invalid cancellation grace period");
  if ((request.bootstrap?.length ?? 0) > MAX_BOOTSTRAP_COMMANDS) throw new Error("too many bootstrap commands");
  for (const command of request.bootstrap ?? []) {
    if (!command.command || command.command.length > 512 || command.args.length > 64 || command.args.some((arg) => arg.length > 2_048)) throw new Error("invalid bootstrap command");
    if (basename(command.command) === "ln") throw new Error("bootstrap symlink commands are forbidden");
    if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 10 || command.timeoutMs > 10 * 60_000) throw new Error("invalid bootstrap timeout");
    if (command.cwd && !inside(cwd, resolve(cwd, command.cwd))) throw new Error("bootstrap cwd escapes the isolated workspace");
    if (command.env && (Object.keys(command.env).length > 32 || Object.entries(command.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.length > 8_192))) throw new Error("invalid explicit bootstrap environment");
  }
  const packetText = stableJson({ contract: request.contractPacket, snapshot: request.snapshotPacket, clarificationAnswers: request.clarificationAnswers ?? [] });
  if (Buffer.byteLength(packetText) > MAX_PACKET_BYTES) throw new Error(`runner packet exceeds ${MAX_PACKET_BYTES} bytes`);
}

function roleSystemPrompt(request: AgentRunRequest, packetText: string): string {
  const roleGuidance = request.role === "implementer"
    ? "Implement only the contract within the write scope. You may use runner_shell for trusted local code execution."
    : request.role === "general-reviewer"
      ? "Independently review requirements and test adequacy, correctness, diagnosis, algorithms, and maintainability; do not limit review to style."
      : request.role === "concern-reviewer"
        ? "Independently review the assigned specialist concerns against the contract and exact cumulative delta."
        : request.role === "plan-reviewer"
          ? "Independently review whether the plan is complete, verifiable, scoped, and safe to execute."
          : "Independently assess initiative-wide acceptance against the contract, cumulative delta, evidence, and final snapshot.";
  return [
    `You are a fresh ${request.role} process.`,
    roleGuidance,
    "You have no implementation conversation, prior reviewer verdict, resumed session, model fallback, or recursive delegation.",
    "Use only the explicitly enabled capability-scoped tools. Worktrees, role prompts, and tool allowlists are not an OS sandbox and do not protect against a hostile same-user process.",
    "Child-run tests and supplied objective evidence are advisory; they never replace parent protected-bash verification.",
    "Return control with runner_report. Use needs-input rather than guessing when a parent decision is required.",
    "Trusted project instructions:",
    ...request.projectInstructions.map((item) => `- ${item}`),
    "Immutable contract/snapshot packet:",
    packetText,
  ].join("\n");
}

async function runBootstrap(request: AgentRunRequest, signal?: AbortSignal): Promise<RunnerFailure | undefined> {
  if (!request.bootstrap?.length) return undefined;
  const scratch = mkdtempSync(join(tmpdir(), `pi-swe-bootstrap-${safeFragment(request.runId)}-`));
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT } : {}),
      HOME: join(scratch, "home"),
      npm_config_cache: join(scratch, "npm-cache"),
      COREPACK_HOME: join(scratch, "corepack"),
      XDG_CACHE_HOME: join(scratch, "xdg-cache"),
    };
    mkdirSync(env.HOME!, { recursive: true });
    mkdirSync(env.npm_config_cache!, { recursive: true });
    mkdirSync(env.COREPACK_HOME!, { recursive: true });
    mkdirSync(env.XDG_CACHE_HOME!, { recursive: true });
    for (const item of request.bootstrap) {
      const cwd = item.cwd ? resolve(request.cwd, item.cwd) : request.cwd;
      const result = await executeBootstrapCommand(item, cwd, { ...env, ...item.env }, signal);
      if (result.cancelled) return failure("cancelled", "dependency bootstrap was cancelled", false, result.status ?? undefined, result.stdout, result.stderr);
      if (result.timedOut) return failure("bootstrap-failed", "dependency bootstrap exceeded its command deadline", false, result.status ?? undefined, result.stdout, result.stderr);
      if (result.error || result.status !== 0) return failure("bootstrap-failed", result.error ? errorMessage(result.error) : `bootstrap command exited ${result.status}`, false, result.status ?? undefined, result.stdout, result.stderr);
      const isolation = dependencyIsolationFailure(request.cwd);
      if (isolation) return failure("bootstrap-isolation", isolation, false);
    }
    return undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

type BootstrapProcessOutcome = { status: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; error?: Error };

async function executeBootstrapCommand(command: BootstrapCommand, cwd: string, env: NodeJS.ProcessEnv, abortSignal?: AbortSignal): Promise<BootstrapProcessOutcome> {
  return await new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let closeStatus: number | null | undefined;
    let sweep: NodeJS.Timeout | undefined;
    const child = spawn(command.command, command.args, { cwd, env, detached: process.platform !== "win32", shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (sweep) clearTimeout(sweep);
      abortSignal?.removeEventListener("abort", onAbort);
      resolvePromise({ status: closeStatus ?? null, stdout, stderr, timedOut, cancelled, ...(error ? { error } : {}) });
    };
    const scheduleSweep = () => {
      signalProcessGroup(child.pid, "SIGTERM");
      sweep ??= setTimeout(() => {
        signalProcessGroup(child.pid, "SIGKILL");
        finish();
      }, 50);
    };
    const stop = (reason: "timeout" | "cancel") => {
      if (reason === "timeout") timedOut = true;
      else cancelled = true;
      scheduleSweep();
    };
    const deadline = setTimeout(() => stop("timeout"), command.timeoutMs);
    const onAbort = () => stop("cancel");
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const remaining = 256 * 1024 - bytes;
      const text = chunk.subarray(0, Math.max(0, remaining)).toString("utf8");
      if (target === "stdout") stdout += text;
      else stderr += text;
      bytes += Math.min(chunk.length, Math.max(0, remaining));
      if (chunk.length > remaining) {
        stderr += "\nbootstrap output exceeded 256 KiB";
        stop("timeout");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (status) => {
      closeStatus = status;
      scheduleSweep();
    });
  });
}

function dependencyIsolationFailure(cwd: string): string | undefined {
  const root = realpathSync(cwd);
  let entries = 0;
  const inspect = (path: string, label: string, depth: number): string | undefined => {
    if (depth > 32 || ++entries > 50_000) return "dependency isolation scan exceeded its depth or entry budget";
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      let actual: string;
      try { actual = realpathSync(path); }
      catch { return `${label} contains a broken dependency symlink`; }
      return inside(root, actual) ? undefined : `${label} contains a dependency symlink outside the isolated workspace`;
    }
    if (!stat.isDirectory()) return depth === 0 ? `${label} must be a directory` : undefined;
    for (const entry of readdirSync(path)) {
      const failure = inspect(join(path, entry), label, depth + 1);
      if (failure) return failure;
    }
    return undefined;
  };
  for (const name of ["node_modules", ".pnpm-store"]) {
    const path = join(root, name);
    try {
      const failure = inspect(path, name, 0);
      if (failure) return failure;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

async function executeProcess(invocation: RunnerInvocation, budgets: RunnerBudgets, abortSignal?: AbortSignal): Promise<ProcessOutcome> {
  return await new Promise((resolvePromise) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let pending = "";
    let outputBytes = 0;
    let turns = 0;
    let forcedCode: RunnerFailureCode | undefined;
    const events: unknown[] = [];
    let escalation: NodeJS.Timeout | undefined;
    let closeOutcome: ProcessOutcome | undefined;
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.effectiveConfig.cwd,
      env: invocation.environment,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const scheduleGroupSweep = (): void => {
      signalProcessGroup(child.pid, "SIGTERM");
      escalation ??= setTimeout(() => {
        signalProcessGroup(child.pid, "SIGKILL");
        finish(closeOutcome ?? { exitCode: null, signal: "SIGKILL", stdout, stderr, events, forcedCode });
      }, budgets.killGraceMs);
    };
    const kill = (code: RunnerFailureCode): void => {
      if (!forcedCode) forcedCode = code;
      scheduleGroupSweep();
    };
    const deadline = setTimeout(() => kill("deadline"), budgets.timeoutMs);
    const onAbort = () => kill("cancelled");
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = budgets.maxOutputBytes - outputBytes;
      if (chunk.length > remaining) {
        stdout += chunk.subarray(0, Math.max(0, remaining)).toString("utf8");
        outputBytes = budgets.maxOutputBytes;
        kill("output-limit");
        return;
      }
      outputBytes += chunk.length;
      const text = chunk.toString("utf8");
      stdout += text;
      pending += text;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as { type?: string };
          events.push(event);
          if (event.type === "turn_start" && ++turns > budgets.maxTurns) kill("turn-limit");
        } catch {
          events.push({ type: "invalid-json-line" });
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = budgets.maxOutputBytes - outputBytes;
      if (chunk.length > remaining) {
        stderr += chunk.subarray(0, Math.max(0, remaining)).toString("utf8");
        outputBytes = budgets.maxOutputBytes;
        kill("output-limit");
        return;
      }
      outputBytes += chunk.length;
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish({ exitCode: null, signal: null, stdout, stderr, events, forcedCode, spawnError: error }));
    child.on("close", (exitCode, signal) => {
      if (pending.trim()) {
        try { events.push(JSON.parse(pending)); }
        catch { events.push({ type: "invalid-json-line" }); }
      }
      closeOutcome = { exitCode, signal, stdout, stderr, events, forcedCode };
      // Sweep descendants even after a nominally successful leader exit. A role shell may
      // have backgrounded trusted local code; completion must not orphan that process tree.
      scheduleGroupSweep();
    });

    function finish(outcome: ProcessOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      abortSignal?.removeEventListener("abort", onAbort);
      resolvePromise(outcome);
    }
  });
}

function classifyOutcome(outcome: ProcessOutcome, request: AgentRunRequest, startedAt: string, completedAt: string): ClassifiedOutcome {
  if (outcome.forcedCode) return { ok: false, failure: failure(outcome.forcedCode, forcedMessage(outcome.forcedCode), false, outcome.exitCode ?? undefined, outcome.stdout, outcome.stderr) };
  if (outcome.spawnError) return { ok: false, failure: failure("spawn-error", errorMessage(outcome.spawnError), true, undefined, outcome.stdout, outcome.stderr) };
  if (outcome.events.some((event) => record(event) && event.type === "invalid-json-line")) return { ok: false, failure: failure("malformed-event", "child emitted a non-JSON event line", false, outcome.exitCode ?? undefined, outcome.stdout, outcome.stderr) };
  const modelError = outcome.events.find((event) => record(event) && event.type === "message_end" && record(event.message) && event.message.role === "assistant" && event.message.stopReason === "error");
  const modelErrorMessage = modelError && record(modelError) && record(modelError.message) ? String(modelError.message.errorMessage ?? "model returned an error") : "";
  if (/no (?:api key|credentials?)|api key.*(?:missing|configured)|unauthorized|authentication/i.test(`${outcome.stderr}\n${modelErrorMessage}`)) return { ok: false, failure: failure("credentials-unavailable", "provider credentials are unavailable to the isolated child", false, outcome.exitCode ?? undefined, outcome.stdout, outcome.stderr) };
  if (modelErrorMessage) return { ok: false, failure: failure("model-error", boundedTail(modelErrorMessage), true, outcome.exitCode ?? undefined, outcome.stdout, outcome.stderr) };
  if (outcome.exitCode !== 0) return { ok: false, failure: failure("nonzero-exit", `Pi child exited with code ${outcome.exitCode ?? "unknown"}`, true, outcome.exitCode ?? undefined, outcome.stdout, outcome.stderr) };
  const sessionIndexes = outcome.events.flatMap((event, index) => record(event) && event.type === "session" ? [index] : []);
  const sessionEvent = sessionIndexes.length === 1 ? outcome.events[sessionIndexes[0]!] : undefined;
  const agentStartIndex = outcome.events.findIndex((event) => record(event) && event.type === "agent_start");
  const reportIndexes = outcome.events.flatMap((event, index) => record(event) && event.type === "tool_execution_end" && event.toolName === "runner_report" ? [index] : []);
  const reportEvents = reportIndexes.map((index) => outcome.events[index]);
  const agentEndIndex = outcome.events.findIndex((event) => record(event) && event.type === "agent_end");
  if (sessionIndexes.length !== 1 || sessionIndexes[0] !== 0 || agentStartIndex < 1 || !record(sessionEvent) || resolve(String(sessionEvent.cwd ?? "")) !== realpathSync(request.cwd)) return { ok: false, failure: failure("malformed-event", "child event stream lacks one leading session header, matching cwd, and agent_start", false, undefined, outcome.stdout, outcome.stderr) };
  const assistantMessages = outcome.events.filter((event) => record(event) && event.type === "message_end" && record(event.message) && event.message.role === "assistant").map((event) => (event as Record<string, any>).message as Record<string, any>);
  if (!assistantMessages.length || assistantMessages.some((message) => message.provider !== request.provider || message.model !== request.model)) return { ok: false, failure: failure("model-mismatch", "child event stream did not confirm the explicitly requested provider and model", false, undefined, outcome.stdout, outcome.stderr) };
  if (reportEvents.length > 1) return { ok: false, failure: failure("malformed-report", "child submitted more than one runner report", false, undefined, outcome.stdout, outcome.stderr) };
  const agentEnded = agentEndIndex >= 0;
  if (!reportEvents.length) return { ok: false, failure: failure(agentEnded ? "missing-report" : "premature-exit", agentEnded ? "child ended without runner_report" : "child exited before agent_end and runner_report", !agentEnded, undefined, outcome.stdout, outcome.stderr) };
  if (!agentEnded || reportIndexes[0]! >= agentEndIndex) return { ok: false, failure: failure("premature-exit", "child reported but exited before an ordered agent_end", true, undefined, outcome.stdout, outcome.stderr) };
  try {
    const event = reportEvents[0] as Record<string, unknown>;
    if (event.isError !== false || !record(event.result) || event.result.terminate !== true) throw new Error("runner_report did not complete as a successful terminating tool");
    const raw = normalizeRawReport(event.result.details, request.role);
    if (raw.changedPaths?.some((path) => !(request.writeScope ?? []).some((scope) => scopeAllowsPath(scope, path)))) throw new Error("implementation report contains an out-of-scope changed path");
    const report = materializeReport(raw, request, startedAt, completedAt);
    return { ok: true, report };
  } catch (error) {
    return { ok: false, failure: failure("malformed-report", errorMessage(error), false, undefined, outcome.stdout, outcome.stderr) };
  }
}

function normalizeRawReport(value: unknown, role: RunnerRole): RawRunnerReport {
  if (!record(value) || typeof value.outcome !== "string" || typeof value.summary !== "string") throw new Error("runner report outcome and summary are required strings");
  const allowed = role === "implementer" ? ["completed", "no-change", "needs-input", "failed"] : ["approved", "changes-requested", "needs-input", "failed"];
  if (!allowed.includes(value.outcome)) throw new Error(`outcome ${value.outcome} is invalid for ${role}`);
  const summary = boundedText(value.summary, "report summary", 2_048);
  const rationale = value.rationale === undefined ? undefined : boundedText(value.rationale, "report rationale", 2_048);
  const changedPaths = value.changedPaths === undefined ? undefined : boundedStringArray(value.changedPaths, "changed paths", 128, 512).map((path) => {
    validateScope(path);
    if (path.includes("*")) throw new Error("changed paths must be exact repository-relative paths");
    return path.replace(/^\.\//, "");
  });
  if (role !== "implementer" && changedPaths?.length) throw new Error("review reports cannot claim changed paths");
  const findings = value.findings === undefined ? [] : normalizeRawFindings(value.findings, role);
  const questions = value.questions === undefined ? [] : boundedStringArray(value.questions, "questions", 32, 2_048);
  if (value.outcome === "needs-input" && !questions.length) throw new Error("needs-input requires at least one question");
  if (value.outcome !== "needs-input" && questions.length) throw new Error("questions are only valid with a needs-input outcome");
  if (value.outcome === "no-change" && (!rationale || rationale.length < 8 || changedPaths?.length)) throw new Error("no-change requires a rationale and no changed paths");
  return { outcome: value.outcome as RawRunnerReport["outcome"], summary, ...(rationale ? { rationale } : {}), ...(changedPaths ? { changedPaths } : {}), findings, ...(questions.length ? { questions } : {}) };
}

function normalizeRawFindings(value: unknown, role: RunnerRole): RawRunnerReport["findings"] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("findings must be a bounded array");
  return value.map((finding) => {
    if (!record(finding) || !["blocking", "warning"].includes(String(finding.severity))) throw new Error("invalid report finding");
    const id = finding.id === undefined ? undefined : boundedId(String(finding.id), "finding id");
    const status = finding.status === undefined ? "open" : finding.status;
    if (!["open", "resolved"].includes(String(status)) || (role === "implementer" && (id || status !== "open"))) throw new Error("only an independent reviewer can confirm an existing finding");
    const disposition = finding.disposition === undefined ? undefined : boundedText(finding.disposition, "finding disposition", 2_048);
    if (status === "resolved" && (!id || !disposition)) throw new Error("resolved finding requires its stable id and a disposition");
    return {
      ...(id ? { id } : {}), severity: finding.severity as "blocking" | "warning", status: status as "open" | "resolved",
      summary: boundedText(finding.summary, "finding summary", 1_024),
      evidence: boundedText(finding.evidence, "finding evidence", 2_048),
      ...(disposition ? { disposition } : {}),
    };
  });
}

function materializeReport(raw: RawRunnerReport, request: AgentRunRequest, startedAt: string, completedAt: string): StageReport {
  const findings: Finding[] = (raw.findings ?? []).map((finding, index) => ({
    id: finding.id ?? correlatedId(request.runId, "f", index),
    severity: finding.severity,
    status: finding.status ?? "open",
    summary: finding.summary,
    evidence: finding.evidence,
    ...(finding.disposition ? { disposition: finding.disposition } : {}),
  }));
  const questions: Clarification[] | undefined = raw.questions?.map((question, index) => ({
    id: correlatedId(request.runId, "q", index),
    question,
    askedByRunId: request.runId,
    askedAt: completedAt,
  }));
  return {
    kind: reportKindForRole(request.role),
    outcome: raw.outcome,
    summary: raw.summary,
    ...(raw.rationale ? { rationale: raw.rationale } : {}),
    ...(raw.changedPaths ? { changedPaths: raw.changedPaths } : {}),
    findings,
    ...(questions?.length ? { questions } : {}),
    provenance: {
      runId: request.runId,
      role: request.role,
      actorId: request.actorId,
      provider: request.provider,
      model: request.model,
      leaseId: request.lease.id,
      leaseFence: request.lease.fence,
      contractHash: request.contractPacket.hash,
      ...(request.snapshotPacket ? { snapshotHash: request.snapshotPacket.hash } : {}),
      startedAt,
      completedAt,
    },
  };
}

function copyAgentCredentials(source: string, target: string): void {
  if (!existsSync(source)) return;
  for (const name of ["auth.json", "models.json"]) {
    const from = join(source, name);
    if (!existsSync(from)) continue;
    const stat = lstatSync(from);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`refusing unsafe agent credential resource ${name}`);
    copyFileSync(from, join(target, name));
    chmodSync(join(target, name), 0o600);
  }
}

function defaultAgentSourceDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function trustedFile(value: string, label: string): string {
  const path = realpathSync(value);
  if (!statSync(path).isFile()) throw new Error(`${label} must be a file`);
  return path;
}

function validateReviewSnapshotPayload(value: unknown): string[] {
  if (!record(value)) throw new Error("review snapshot payload must be an object");
  for (const forbidden of ["implementationConversation", "conversation", "reviewerVerdict", "priorVerdict", "transcript"]) if (forbidden in value) throw new Error(`review snapshot must not contain ${forbidden}`);
  if (typeof value.cumulativeDelta !== "string" || value.cumulativeDelta.length > 128 * 1024) throw new Error("review snapshot requires a bounded exact cumulative delta");
  const relevantFiles = boundedStringArray(value.relevantFiles, "relevant files", 128, 512).map((path) => {
    validateScope(path);
    if (path.includes("*")) throw new Error("relevant files must be exact repository-relative paths");
    return path.replace(/^\.\//, "");
  });
  if (!Array.isArray(value.objectiveEvidence) || value.objectiveEvidence.length > 64) throw new Error("review snapshot requires bounded objective evidence");
  return relevantFiles;
}

function validateScope(scope: string): void {
  if (typeof scope !== "string" || !scope || scope.length > 512 || !SAFE_PATH.test(scope) || scope.includes("\0")) throw new Error("invalid runner capability scope");
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The child may have exited between close detection and group signalling.
  }
}

function failure(code: RunnerFailureCode, message: string, retryable = RETRYABLE_FAILURES.has(code), exitCode?: number, stdout?: string, stderr?: string): RunnerFailure {
  return { code, message: boundedTail(message), retryable, ...(exitCode === undefined ? {} : { exitCode }), ...(stdout ? { stdoutTail: boundedTail(stdout) } : {}), ...(stderr ? { stderrTail: boundedTail(stderr) } : {}) };
}

function forcedMessage(code: RunnerFailureCode): string {
  if (code === "deadline") return "agent run exceeded its time budget";
  if (code === "cancelled") return "agent run was cancelled";
  if (code === "turn-limit") return "agent run exceeded its turn budget";
  return "agent run exceeded its output budget";
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new Error(`${label} must be a non-empty string of at most 128 characters`);
  return value;
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  return value.trim();
}

function boundedStringArray(value: unknown, label: string, count: number, length: number): string[] {
  if (!Array.isArray(value) || value.length > count) throw new Error(`${label} must contain at most ${count} entries`);
  return value.map((item) => boundedText(item, label, length));
}

function correlatedId(runId: string, kind: "f" | "q", index: number): string {
  const suffix = `-${kind}${String(index + 1).padStart(3, "0")}`;
  const cleaned = runId.replace(/[^A-Za-z0-9._-]/g, "-");
  const prefix = cleaned.length + suffix.length <= 64 ? cleaned : `run-${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
  return `${prefix}${suffix}`;
}

function stableJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (item: unknown): unknown => {
    if (!item || typeof item !== "object") return item;
    if (seen.has(item as object)) throw new Error("runner packet must not contain cycles");
    seen.add(item as object);
    const result = Array.isArray(item)
      ? item.map(normalize)
      : Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]));
    seen.delete(item as object);
    return result;
  };
  const text = JSON.stringify(normalize(value));
  if (text === undefined) throw new Error("runner packet is not serializable");
  return text;
}

function fileHash(path: string): string { return hash(readFileSync(path)); }
function hash(value: string | Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function safeFragment(value: string): string { return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 24) || "run"; }
function boundedTail(value: string): string { return value.length <= MAX_TAIL ? value : value.slice(-MAX_TAIL); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function record(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }

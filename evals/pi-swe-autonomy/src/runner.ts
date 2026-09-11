import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ThinkingLevel,
} from "@earendil-works/pi-coding-agent";

import { digestContentTree } from "./fixture.ts";
import { EvaluationRecorder } from "./recorder.ts";
import {
  createTrialResources,
  type ResourceLoaderLike,
  type ResourceProfile,
} from "./resources.ts";

export type TrialBudgets = {
  readonly wallTimeMs: number;
  readonly maxModelCalls: number;
  readonly maxTokens: number;
  readonly maxCostUsd: number;
};

export type SdkTrialRequest = {
  readonly trialId: string;
  readonly workspacePath: string;
  readonly fixtureDigest: string;
  readonly sessionDirectory: string;
  readonly tracePath: string;
  readonly agentDir: string;
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel | string;
  readonly readinessPrompt: string;
  readonly sandboxAcknowledged: boolean;
  readonly resourceProfile: Omit<ResourceProfile, "cwd" | "agentDir">;
  readonly budgets: TrialBudgets;
};

export type InfrastructureFailureCode =
  | "sandbox-required"
  | "missing-model"
  | "missing-tool"
  | "resource-mismatch"
  | "budget-exhausted"
  | "timeout"
  | "provider-error"
  | "session-error";

export type SdkTrialResult = {
  readonly outcome: "completed" | "infrastructure-failure";
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly modelCalls: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly failure?: { readonly code: InfrastructureFailureCode; readonly message: string };
};

export interface AgentSessionLike {
  readonly sessionId: string;
  readonly sessionFile?: string;
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
  getActiveToolNames(): string[];
  getSessionStats(): { tokens: { total: number }; cost: number };
}

interface ModelRuntimeLike {
  getModel(provider: string, modelId: string): unknown;
}

interface SettingsManagerLike {
  flush(): Promise<void> | void;
}

export interface RunnerSdk {
  createModelRuntime(options: Record<string, unknown>): Promise<ModelRuntimeLike>;
  createSettingsManager(settings: Record<string, unknown>): SettingsManagerLike;
  createSessionManager(cwd: string, sessionDirectory: string, options: { id: string }): unknown;
  createResourceLoader(options: Record<string, unknown>): ResourceLoaderLike;
  createAgentSession(options: Record<string, unknown>): Promise<{
    session: AgentSessionLike;
    extensionsResult?: { errors?: readonly { error?: string }[] };
  }>;
}

const productionSdk: RunnerSdk = {
  createModelRuntime: (options) => ModelRuntime.create(options),
  createSettingsManager: (settings) => SettingsManager.inMemory(settings),
  createSessionManager: (cwd, sessionDirectory, options) => SessionManager.create(cwd, sessionDirectory, options),
  createResourceLoader: (options) => new DefaultResourceLoader(options as ConstructorParameters<typeof DefaultResourceLoader>[0]),
  createAgentSession: async (options) => {
    const result = await createAgentSession(options as Parameters<typeof createAgentSession>[0]);
    return { session: result.session as unknown as AgentSessionLike, extensionsResult: result.extensionsResult };
  },
};

export async function runSdkTrial(request: SdkTrialRequest, sdk: RunnerSdk = productionSdk): Promise<SdkTrialResult> {
  let modelCalls = 0;
  let recorder: EvaluationRecorder | undefined;
  let session: AgentSessionLike | undefined;
  let settingsManager: SettingsManagerLike | undefined;
  let unsubscribe: (() => void) | undefined;
  let budgetFailure: Error | undefined;
  let terminalProviderError: string | undefined;
  const deadline = Date.now() + request.budgets.wallTimeMs;
  const abortController = new AbortController();

  const withinDeadline = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        void session?.abort();
        reject(new TrialTimeoutError(request.budgets.wallTimeMs));
      }, Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const metrics = (): Pick<SdkTrialResult, "modelCalls" | "tokens" | "costUsd"> => {
    const stats = session?.getSessionStats();
    return { modelCalls, tokens: stats?.tokens.total ?? 0, costUsd: stats?.cost ?? 0 };
  };
  const failure = (code: InfrastructureFailureCode, message: string): SdkTrialResult => ({
    outcome: "infrastructure-failure",
    sessionId: session?.sessionId,
    sessionFile: session?.sessionFile,
    ...metrics(),
    failure: { code, message },
  });

  try {
    if (!request.sandboxAcknowledged) return failure("sandbox-required", "live SDK trials require explicit container or equivalent sandbox acknowledgement");
    if (!request.readinessPrompt) return failure("session-error", "readinessPrompt must be non-empty");
    validateBudgets(request.budgets);
    realpathSync.native(request.workspacePath);
    const startingFixture = digestContentTree(request.workspacePath);
    if (startingFixture.digest !== request.fixtureDigest) {
      return failure("resource-mismatch", `fixture digest mismatch: expected ${request.fixtureDigest}, observed ${startingFixture.digest}`);
    }
    mkdirSync(request.sessionDirectory, { recursive: true, mode: 0o700 });

    recorder = new EvaluationRecorder(request.trialId, request.tracePath);
    recorder.record("fixture_identity", { contentTreeDigest: startingFixture.digest, files: startingFixture.files });
    settingsManager = sdk.createSettingsManager({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 } });
    const modelRuntime = await withinDeadline(sdk.createModelRuntime({
      authPath: join(request.agentDir, "auth.json"),
      modelsPath: join(request.agentDir, "models.json"),
      allowModelNetwork: false,
      signal: abortController.signal,
    }));
    const model = modelRuntime.getModel(request.provider, request.modelId);
    if (!model) return failure("missing-model", `model not found: ${request.provider}/${request.modelId}`);

    let resources;
    try {
      resources = await withinDeadline(createTrialResources({
        ...request.resourceProfile,
        cwd: request.workspacePath,
        agentDir: request.agentDir,
        settingsManager,
      }, { createLoader: (options) => sdk.createResourceLoader(options) }));
    } catch (error) {
      if (error instanceof TrialTimeoutError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return failure("resource-mismatch", message);
    }
    recorder.record("resource_manifest", resources.manifest);

    const sessionManager = sdk.createSessionManager(request.workspacePath, request.sessionDirectory, { id: request.trialId });
    const creation = sdk.createAgentSession({
      cwd: request.workspacePath,
      agentDir: request.agentDir,
      modelRuntime,
      model,
      thinkingLevel: request.thinkingLevel,
      tools: [...request.resourceProfile.tools],
      resourceLoader: resources.loader,
      sessionManager,
      settingsManager,
    });
    void creation.then((late) => {
      if (abortController.signal.aborted && session === undefined) late.session.dispose();
    }, () => {});
    const created = await withinDeadline(creation);
    session = created.session;
    const extensionErrors = created.extensionsResult?.errors ?? [];
    if (extensionErrors.length) return failure("resource-mismatch", extensionErrors.map((item) => item.error ?? "extension setup failed").join("; "));

    const activeTools = new Set(session.getActiveToolNames());
    const missingTools = request.resourceProfile.tools.filter((name) => !activeTools.has(name));
    if (missingTools.length) return failure("missing-tool", `required tools unavailable: ${missingTools.join(", ")}`);

    let resolveSettled: (() => void) | undefined;
    unsubscribe = session.subscribe((event) => {
      recorder?.recordSessionEvent(event);
      if (event.type === "turn_start") modelCalls += 1;
      terminalProviderError = terminalProviderError ?? providerErrorFromEvent(event);
      if (event.type === "agent_settled") {
        resolveSettled?.();
        resolveSettled = undefined;
      }
      const current = metrics();
      if (!budgetFailure && (
        current.modelCalls > request.budgets.maxModelCalls
        || current.tokens > request.budgets.maxTokens
        || current.costUsd > request.budgets.maxCostUsd
      )) {
        budgetFailure = new Error("trial budget exhausted");
        recorder?.record("budget_exhausted", current);
        void session?.abort();
      }
    });

    const promptAndWaitForSettled = async (phase: "readiness" | "approval", text: string): Promise<void> => {
      terminalProviderError = undefined;
      const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
      recorder?.recordPrompt(phase, text);
      try {
        await withinDeadline(Promise.all([session!.prompt(text), settled]));
      } catch (error) {
        if (error instanceof TrialTimeoutError || error === budgetFailure) throw error;
        throw new ProviderTrialError(error instanceof Error ? error.message : String(error));
      } finally {
        resolveSettled = undefined;
      }
      if (budgetFailure) throw budgetFailure;
      if (terminalProviderError) throw new ProviderTrialError(terminalProviderError);
    };

    await promptAndWaitForSettled("readiness", request.readinessPrompt);
    await promptAndWaitForSettled("approval", "Approved");
    return {
      outcome: "completed",
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      ...metrics(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof TrialTimeoutError) return failure("timeout", message);
    if (budgetFailure && error === budgetFailure) return failure("budget-exhausted", message);
    if (error instanceof ProviderTrialError || /provider|rate.?limit|authentication|api key|network/i.test(message)) return failure("provider-error", message);
    return failure("session-error", message);
  } finally {
    abortController.abort();
    unsubscribe?.();
    session?.dispose();
    recorder?.close();
    try {
      const flushed = settingsManager?.flush();
      if (flushed) await withinDeadline(Promise.resolve(flushed));
    } catch {}
  }
}

function providerErrorFromEvent(event: Readonly<Record<string, unknown>>): string | undefined {
  if (event.type === "auto_retry_end" && event.success === false && typeof event.finalError === "string") return event.finalError;
  const messages = event.type === "agent_end" && Array.isArray(event.messages)
    ? event.messages
    : event.type === "message_end"
      ? [event.message]
      : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    const candidate = message as Record<string, unknown>;
    if (candidate.role === "assistant" && candidate.stopReason === "error") {
      return typeof candidate.errorMessage === "string" && candidate.errorMessage
        ? candidate.errorMessage
        : "provider returned a terminal assistant error";
    }
  }
  return undefined;
}

class ProviderTrialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderTrialError";
  }
}

class TrialTimeoutError extends Error {
  constructor(wallTimeMs: number) {
    super(`trial prompt timed out after ${wallTimeMs}ms`);
    this.name = "TrialTimeoutError";
  }
}

function validateBudgets(budgets: TrialBudgets): void {
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`);
  }
  if (budgets.wallTimeMs === 0) throw new Error("wallTimeMs must be greater than zero");
}

export type { AgentSessionEvent };

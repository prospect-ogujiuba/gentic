import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SweExternalTodo = {
  id?: string;
  title?: string;
  status?: string;
  acceptanceCriteria?: string[];
  definitionOfDone?: string[];
};

export type SweTodoScope = Record<string, unknown>;
export type SweTodoEvidence = Record<string, unknown>;

export type SweCapabilityWarning = {
  source: string;
  message: string;
};

export type SweExternalCapabilities = {
  getActiveTodo?: () => SweExternalTodo | undefined;
  getTodoScope?: () => SweTodoScope | undefined;
  getTodoEvidence?: () => SweTodoEvidence[];
  listDetectedExtensions?: () => string[];
};

export type SweCapabilityAdapter = SweExternalCapabilities & {
  getWarnings: () => SweCapabilityWarning[];
};

type UnknownRecord = Record<string, unknown>;
type ProviderLookup = {
  provider?: UnknownRecord;
  providerNames: string[];
  warnings: SweCapabilityWarning[];
};

const TODO_PROVIDER_NAMES = ["pi-todo", "todo", "gentic.todo"];
const CAPABILITY_EVENTS = ["gentic:capabilities:collect", "pi:capabilities:collect"];

export function createSweExternalCapabilities(pi: ExtensionAPI): SweCapabilityAdapter {
  const lookup = lookupTodoProvider(pi);
  const readWarnings: SweCapabilityWarning[] = [];

  const adapter: SweCapabilityAdapter = {
    getActiveTodo: () => readProviderMethod(lookup.provider, "getActiveTodo", normalizeTodo, readWarnings),
    getTodoScope: () => readProviderMethod(lookup.provider, "getTodoScope", normalizeScope, readWarnings),
    getTodoEvidence: () => readProviderMethod(lookup.provider, "getTodoEvidence", normalizeEvidence, readWarnings) ?? [],
    listDetectedExtensions: () => listDetectedExtensions(pi, lookup.providerNames),
    getWarnings: () => dedupeWarnings([...lookup.warnings, ...readWarnings]),
  };

  return adapter;
}

function lookupTodoProvider(pi: ExtensionAPI): ProviderLookup {
  const warnings: SweCapabilityWarning[] = [];
  const providers = new Map<string, UnknownRecord>();
  const root = pi as unknown as UnknownRecord;

  collectNamedProvider(providers, root, warnings, "ExtensionAPI", ["getCapability"]);
  collectNamedProvider(providers, root, warnings, "ExtensionAPI", ["capabilities"]);
  collectNamedProvider(providers, root, warnings, "ExtensionAPI", ["registry", "getCapability"]);
  collectNamedProvider(providers, root, warnings, "ExtensionAPI", ["registry", "capabilities"]);

  collectEventProviders(providers, root, warnings);

  for (const name of TODO_PROVIDER_NAMES) {
    const provider = providers.get(name);
    if (provider) return { provider: unwrapTodoProvider(provider), providerNames: [...providers.keys()], warnings };
  }

  const first = providers.entries().next().value as [string, UnknownRecord] | undefined;
  return { provider: first ? unwrapTodoProvider(first[1]) : undefined, providerNames: [...providers.keys()], warnings };
}

function collectNamedProvider(providers: Map<string, UnknownRecord>, root: UnknownRecord, warnings: SweCapabilityWarning[], source: string, path: string[]): void {
  const surface = resolvePath(root, path);
  if (!surface) return;

  for (const name of TODO_PROVIDER_NAMES) {
    const value = readNamedValue(surface, name, warnings, `${source}.${path.join(".")}`);
    if (isPlainObject(value)) providers.set(name, value);
    else if (value !== undefined) warnings.push({ source: name, message: `capability provider from ${path.join(".")} is malformed` });
  }
}

function collectEventProviders(providers: Map<string, UnknownRecord>, root: UnknownRecord, warnings: SweCapabilityWarning[]): void {
  const events = root.events;
  if (!isPlainObject(events) || typeof events.emit !== "function") return;

  for (const eventName of CAPABILITY_EVENTS) {
    const collected = new Map<string, UnknownRecord>();
    const request = {
      consumer: "pi-swe",
      register(name: string, provider: unknown) {
        if (typeof name !== "string" || !name.trim()) {
          warnings.push({ source: eventName, message: "capability registry ignored unnamed provider" });
          return;
        }
        if (!isPlainObject(provider)) {
          warnings.push({ source: name, message: "capability provider is malformed" });
          return;
        }
        collected.set(name, provider);
      },
      providers: collected,
    };

    try {
      (events.emit as Function)(eventName, request);
    } catch (error) {
      warnings.push({ source: eventName, message: `capability registry lookup failed: ${errorMessage(error)}` });
      continue;
    }

    for (const [name, provider] of collected) providers.set(name, provider);
  }
}

function readNamedValue(surface: unknown, name: string, warnings: SweCapabilityWarning[], source: string): unknown {
  try {
    if (surface instanceof Map) return surface.get(name);
    if (isPlainObject(surface) && typeof surface.get === "function") return (surface.get as Function)(name);
    if (isPlainObject(surface) && typeof surface.getCapability === "function") return (surface.getCapability as Function)(name);
    if (isPlainObject(surface)) return surface[name];
    if (typeof surface === "function") return (surface as Function)(name);
  } catch (error) {
    warnings.push({ source, message: `capability lookup for ${name} failed: ${errorMessage(error)}` });
  }
  return undefined;
}

function readProviderMethod<T>(provider: UnknownRecord | undefined, methodName: string, normalize: (value: unknown) => T | undefined, warnings: SweCapabilityWarning[]): T | undefined {
  if (!provider) return undefined;
  const method = provider[methodName];
  if (method === undefined) return undefined;
  if (typeof method !== "function") {
    warnings.push({ source: "pi-todo", message: `${methodName} capability is not callable` });
    return undefined;
  }

  try {
    const value = (method as Function)();
    if (isPromiseLike(value)) {
      warnings.push({ source: "pi-todo", message: `${methodName} returned a Promise; async capability reads are ignored` });
      return undefined;
    }
    const normalized = normalize(value);
    if (value !== undefined && normalized === undefined) warnings.push({ source: "pi-todo", message: `${methodName} returned malformed data` });
    return normalized;
  } catch (error) {
    warnings.push({ source: "pi-todo", message: `${methodName} failed: ${errorMessage(error)}` });
    return undefined;
  }
}

function normalizeTodo(value: unknown): SweExternalTodo | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) return undefined;

  const todo: SweExternalTodo = {};
  if (typeof value.id === "string") todo.id = value.id;
  if (typeof value.title === "string") todo.title = value.title;
  if (typeof value.status === "string") todo.status = value.status;
  if (isStringArray(value.acceptanceCriteria)) todo.acceptanceCriteria = [...value.acceptanceCriteria];
  if (isStringArray(value.definitionOfDone)) todo.definitionOfDone = [...value.definitionOfDone];

  return Object.keys(todo).length ? todo : undefined;
}

function normalizeScope(value: unknown): SweTodoScope | undefined {
  if (value === undefined || value === null) return undefined;
  return isPlainObject(value) ? { ...value } : undefined;
}

function normalizeEvidence(value: unknown): SweTodoEvidence[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  return value.filter(isPlainObject).map((entry) => ({ ...entry }));
}

function listDetectedExtensions(pi: ExtensionAPI, providerNames: readonly string[]): string[] {
  const names = new Set<string>();

  for (const name of providerNames) addPeerName(names, name);
  for (const command of safeArray(() => pi.getCommands())) addPeerName(names, commandName(command), commandPath(command));
  for (const tool of safeArray(() => (pi as unknown as { getAllTools?: () => unknown[] }).getAllTools?.())) addPeerName(names, commandName(tool), commandPath(tool));

  names.delete("pi-swe");
  return [...names].sort();
}

function addPeerName(names: Set<string>, rawName?: string, rawPath?: string): void {
  const pathName = rawPath?.split("/extensions/")[1]?.split("/")[0];
  const name = normalizePeerName(pathName) ?? normalizePeerName(rawName);
  if (name) names.add(name);
}

function normalizePeerName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/^\//, "");
  if (!normalized) return undefined;
  if (normalized === "todo") return "pi-todo";
  if (normalized === "gate") return "pi-gate";
  if (normalized.startsWith("pi-")) return normalized;
  return undefined;
}

function unwrapTodoProvider(provider: UnknownRecord): UnknownRecord {
  for (const key of ["todo", "piTodo", "capabilities"]) {
    const nested = provider[key];
    if (isPlainObject(nested)) return nested;
  }
  return provider;
}

function commandName(value: unknown): string | undefined {
  return isPlainObject(value) && typeof value.name === "string" ? value.name : undefined;
}

function commandPath(value: unknown): string | undefined {
  const sourceInfo = isPlainObject(value) ? value.sourceInfo : undefined;
  return isPlainObject(sourceInfo) && typeof sourceInfo.path === "string" ? sourceInfo.path : undefined;
}

function resolvePath(root: UnknownRecord, path: string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function safeArray<T>(read: () => T[] | undefined): T[] {
  try {
    const value = read();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function dedupeWarnings(warnings: readonly SweCapabilityWarning[]): SweCapabilityWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.source}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPromiseLike(value: unknown): boolean {
  return isPlainObject(value) && typeof value.then === "function";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

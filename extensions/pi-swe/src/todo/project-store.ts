import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

import { TODO_MAX_ITEMS, TODO_TEXT_LIMITS, type TodoPublicItem } from "./contract.ts";
import type { TodoCoreState } from "./state-core.ts";

export const PROJECT_TODO_FILE = ".pi-todos.json";
const PROJECT_TODO_KIND = "gentic.project-todos";
const PROJECT_TODO_SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 1_048_576;

type ProjectTodoDocument = {
  kind: typeof PROJECT_TODO_KIND;
  schemaVersion: typeof PROJECT_TODO_SCHEMA_VERSION;
  revision: number;
  updatedAt: string;
  todos: TodoPublicItem[];
};

export type ProjectTodoSnapshot = {
  path: string;
  revision: number;
  hash: string | undefined;
  state: TodoCoreState;
};

export class ProjectTodoStoreError extends Error {
  readonly code: "MALFORMED_PROJECT_TODOS" | "STALE_PROJECT_TODOS" | "PROJECT_TODOS_LOCKED" | "UNSAFE_PROJECT_TODO_PATH";

  constructor(code: ProjectTodoStoreError["code"], message: string) {
    super(message);
    this.name = "ProjectTodoStoreError";
    this.code = code;
  }
}

type ProjectTodoStoreOptions = {
  now?: () => string;
  beforeRename?: (temporaryPath: string, targetPath: string) => void;
};

/** Closed-schema, compare-and-swap snapshot storage for tracked project todos. */
export class ProjectTodoStore {
  readonly root: string;
  readonly path: string;
  private readonly now: () => string;
  private readonly beforeRename?: ProjectTodoStoreOptions["beforeRename"];

  constructor(cwd: string, options: ProjectTodoStoreOptions = {}) {
    this.root = findProjectRoot(cwd);
    this.path = join(this.root, PROJECT_TODO_FILE);
    this.now = options.now ?? (() => new Date().toISOString());
    this.beforeRename = options.beforeRename;
  }

  read(): ProjectTodoSnapshot {
    rejectSymlink(this.path);
    if (!existsSync(this.path)) return { path: this.path, revision: 0, hash: undefined, state: emptyState() };
    const stats = statSync(this.path);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
      throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", `${PROJECT_TODO_FILE} must be a regular file no larger than ${MAX_FILE_BYTES} bytes`);
    }
    const raw = readFileSync(this.path, "utf8");
    const document = decodeDocument(raw);
    return { path: this.path, revision: document.revision, hash: digest(raw), state: stateFromTodos(document.todos) };
  }

  write(expected: Pick<ProjectTodoSnapshot, "revision" | "hash">, state: TodoCoreState): ProjectTodoSnapshot {
    const lockPath = `${this.path}.lock`;
    let lock: number | undefined;
    let temporaryPath: string | undefined;
    try {
      rejectSymlink(lockPath);
      try {
        lock = openSync(lockPath, "wx", 0o600);
      } catch (error) {
        throw new ProjectTodoStoreError("PROJECT_TODOS_LOCKED", `project todo lock is held: ${lockPath}`);
      }
      const current = this.read();
      if (current.revision !== expected.revision || current.hash !== expected.hash) {
        throw new ProjectTodoStoreError("STALE_PROJECT_TODOS", `${PROJECT_TODO_FILE} changed; reload and retry`);
      }
      const todos = validateState(state);
      const document: ProjectTodoDocument = {
        kind: PROJECT_TODO_KIND,
        schemaVersion: PROJECT_TODO_SCHEMA_VERSION,
        revision: current.revision + 1,
        updatedAt: this.now(),
        todos,
      };
      const raw = `${JSON.stringify(document, null, 2)}\n`;
      temporaryPath = join(this.root, `.${PROJECT_TODO_FILE}.${process.pid}.${randomUUID()}.tmp`);
      const temporary = openSync(temporaryPath, "wx", 0o600);
      try {
        writeFileSync(temporary, raw, "utf8");
        fsyncSync(temporary);
      } finally {
        closeSync(temporary);
      }
      this.beforeRename?.(temporaryPath, this.path);
      rejectSymlink(this.path);
      renameSync(temporaryPath, this.path);
      temporaryPath = undefined;
      const directory = openSync(dirname(this.path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return { path: this.path, revision: document.revision, hash: digest(raw), state: stateFromTodos(todos) };
    } finally {
      if (temporaryPath) rmSync(temporaryPath, { force: true });
      if (lock !== undefined) closeSync(lock);
      if (lock !== undefined) rmSync(lockPath, { force: true });
    }
  }
}

export function findProjectRoot(cwd: string): string {
  let current = realpathSync(resolve(cwd));
  if (!statSync(current).isDirectory()) throw new ProjectTodoStoreError("UNSAFE_PROJECT_TODO_PATH", "todo cwd must be a directory");
  const filesystemRoot = parse(current).root;
  while (true) {
    const marker = join(current, ".git");
    if (existsSync(marker)) {
      const markerStat = lstatSync(marker);
      if (markerStat.isSymbolicLink()) throw new ProjectTodoStoreError("UNSAFE_PROJECT_TODO_PATH", ".git marker must not be a symlink");
      if (!markerStat.isDirectory() && !markerStat.isFile()) throw new ProjectTodoStoreError("UNSAFE_PROJECT_TODO_PATH", "invalid .git marker");
      return current;
    }
    if (current === filesystemRoot) return realpathSync(resolve(cwd));
    current = dirname(current);
  }
}

function decodeDocument(raw: string): ProjectTodoDocument {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", `${PROJECT_TODO_FILE} contains malformed JSON`); }
  const document = exactRecord(value, ["kind", "schemaVersion", "revision", "updatedAt", "todos"]);
  if (!document || document.kind !== PROJECT_TODO_KIND || document.schemaVersion !== PROJECT_TODO_SCHEMA_VERSION
    || !Number.isSafeInteger(document.revision) || (document.revision as number) < 1
    || typeof document.updatedAt !== "string" || !Number.isFinite(Date.parse(document.updatedAt))
    || !Array.isArray(document.todos)) {
    throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", `${PROJECT_TODO_FILE} does not match schema version ${PROJECT_TODO_SCHEMA_VERSION}`);
  }
  const state = stateFromTodos(document.todos.map(decodeTodo));
  return {
    kind: PROJECT_TODO_KIND,
    schemaVersion: PROJECT_TODO_SCHEMA_VERSION,
    revision: document.revision as number,
    updatedAt: document.updatedAt,
    todos: validateState(state),
  };
}

function decodeTodo(value: unknown): TodoPublicItem {
  const item = exactRecord(value, ["id", "title", "status"], ["parentTodoId", "blockedReason"]);
  if (!item || typeof item.id !== "string" || typeof item.title !== "string"
    || !["ready", "in_progress", "external_blocked", "completed"].includes(String(item.status))) {
    throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "invalid project todo item");
  }
  if (!safeId(item.id) || !publicLine(item.title, TODO_TEXT_LIMITS.title)) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "invalid project todo id or title");
  if (item.parentTodoId !== undefined && (typeof item.parentTodoId !== "string" || !safeId(item.parentTodoId))) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "invalid project todo parent");
  if (item.blockedReason !== undefined && (typeof item.blockedReason !== "string" || !publicLine(item.blockedReason, TODO_TEXT_LIMITS.reason))) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "invalid project todo blocker");
  if (item.status === "external_blocked" && item.blockedReason === undefined) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "blocked project todo requires a reason");
  if (item.status !== "external_blocked" && item.blockedReason !== undefined) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "only blocked project todos may have a reason");
  return item as TodoPublicItem;
}

function validateState(state: TodoCoreState): TodoPublicItem[] {
  if (state.order.length > TODO_MAX_ITEMS || Object.keys(state.todos).length !== state.order.length) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "invalid project todo item count or order");
  const seen = new Set<string>();
  let active: string | undefined;
  const todos = state.order.map((id) => {
    if (seen.has(id) || !state.todos[id]) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "duplicate or missing project todo order entry");
    seen.add(id);
    const todo = decodeTodo(state.todos[id]);
    if (todo.id !== id) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "project todo key and id differ");
    if (todo.status === "in_progress") {
      if (active) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "only one project todo may be active");
      active = id;
    }
    return { ...todo };
  });
  for (const todo of todos) {
    if (todo.parentTodoId && !seen.has(todo.parentTodoId)) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", `missing project todo parent: ${todo.parentTodoId}`);
    if (todo.status === "completed" && todos.some((candidate) => isDescendant(state, candidate.id, todo.id) && candidate.status !== "completed")) {
      throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "completed project todo has open descendants");
    }
    const ancestors = new Set([todo.id]);
    let parentId = todo.parentTodoId;
    while (parentId) {
      if (ancestors.has(parentId)) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "project todo hierarchy contains a cycle");
      ancestors.add(parentId);
      parentId = state.todos[parentId]?.parentTodoId;
    }
  }
  if (state.activeTodoId !== active) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "project todo active index is inconsistent");
  return todos;
}

function stateFromTodos(todos: TodoPublicItem[]): TodoCoreState {
  if (todos.length > TODO_MAX_ITEMS) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "too many project todos");
  const state: TodoCoreState = { todos: {}, order: [] };
  for (const todo of todos) {
    if (state.todos[todo.id]) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", `duplicate project todo id: ${todo.id}`);
    state.todos[todo.id] = { ...todo };
    state.order.push(todo.id);
    if (todo.status === "in_progress") {
      if (state.activeTodoId) throw new ProjectTodoStoreError("MALFORMED_PROJECT_TODOS", "only one project todo may be active");
      state.activeTodoId = todo.id;
    }
  }
  validateState(state);
  return state;
}

function exactRecord(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in record)) || Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  return record;
}

function rejectSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new ProjectTodoStoreError("UNSAFE_PROJECT_TODO_PATH", `refusing symlinked project todo path: ${path}`);
  } catch (error) {
    if (error instanceof ProjectTodoStoreError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isDescendant(state: TodoCoreState, candidateId: string, parentId: string): boolean {
  let current = state.todos[candidateId]?.parentTodoId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === parentId) return true;
    seen.add(current);
    current = state.todos[current]?.parentTodoId;
  }
  return false;
}

function safeId(value: string): boolean {
  return value.length > 0 && value.length <= TODO_TEXT_LIMITS.todoId && /^[A-Za-z0-9._:-]+$/.test(value);
}

function publicLine(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && value === value.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function emptyState(): TodoCoreState { return { todos: {}, order: [] }; }
function digest(raw: string): string { return `sha256:${createHash("sha256").update(raw).digest("hex")}`; }

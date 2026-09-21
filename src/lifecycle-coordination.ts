export type LifecycleContext = {
  cwd: string;
  sessionManager: { getBranch(): readonly unknown[] };
};

export type ActiveTodoSummary = { id: string; title: string };
export type ActiveSweSummary = { initiativeId: string; workId: string; title: string };
type TodoActivityProbe = (ctx: LifecycleContext) => Promise<ActiveTodoSummary | undefined>;
type SweActivityProbe = (ctx: LifecycleContext) => boolean | Promise<boolean>;

let todoActivityProbe: TodoActivityProbe | undefined;
let sweActivityProbe: SweActivityProbe | undefined;

/** Registers the optional pi-todo side of the shared lifecycle contract. */
export function registerTodoActivityProbe(probe: TodoActivityProbe): void {
  todoActivityProbe = probe;
}

/** Registers the optional pi-swe side without coupling pi-todo to SWE storage. */
export function registerSweActivityProbe(probe: SweActivityProbe): void {
  sweActivityProbe = probe;
}

/** Returns active todo work when pi-todo is loaded; absence means pi-swe may activate. */
export async function coordinatedActiveTodo(ctx: LifecycleContext): Promise<ActiveTodoSummary | undefined> {
  return todoActivityProbe?.(ctx);
}

/** Returns whether loaded pi-swe owns active work; absence means it does not. */
export async function coordinatedActiveSwe(ctx: LifecycleContext): Promise<boolean> {
  return (await sweActivityProbe?.(ctx)) === true;
}

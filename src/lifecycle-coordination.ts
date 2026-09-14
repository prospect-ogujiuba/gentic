export type LifecycleContext = {
  cwd: string;
  sessionManager: { getBranch(): readonly unknown[] };
};

export type ActiveTodoSummary = { id: string; title: string };
type TodoActivityProbe = (ctx: LifecycleContext) => Promise<ActiveTodoSummary | undefined>;

let todoActivityProbe: TodoActivityProbe | undefined;

/** Registers the optional pi-todo side of the pi-swe/pi-todo lifecycle contract. */
export function registerTodoActivityProbe(probe: TodoActivityProbe): void {
  todoActivityProbe = probe;
}

/** Returns active todo work when pi-todo is loaded; absence means pi-swe may activate. */
export async function coordinatedActiveTodo(ctx: LifecycleContext): Promise<ActiveTodoSummary | undefined> {
  return todoActivityProbe?.(ctx);
}

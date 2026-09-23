export type CommandCompletion = {
  value: string;
  label: string;
  description: string;
};

/** Presentation metadata only. Parsing and domain behavior remain extension-owned. */
export type CommandActionSpec<Action extends string = string> = {
  action: Action;
  syntax: string;
  description: string;
  help?: string;
};

export function rootActionCompletions<Action extends string>(
  prefix: string,
  actions: readonly CommandActionSpec<Action>[],
): CommandCompletion[] {
  const normalized = prefix.trimStart();
  if (/\s/.test(normalized)) return [];
  return actions
    .filter((item) => item.action.startsWith(normalized))
    .map((item) => ({
      value: item.action,
      label: item.action,
      description: `${item.description} · ${item.syntax}`,
    }));
}

/** Build a nested completion value without losing the command prefix already typed. */
export function prefixedCompletions(
  argumentPrefix: string,
  candidates: readonly CommandCompletion[],
): CommandCompletion[] {
  return candidates.map((item) => ({ ...item, value: `${argumentPrefix}${item.value}` }));
}

export function renderActionHelp<Action extends string>(
  actions: readonly CommandActionSpec<Action>[],
  selected?: readonly Action[],
): string[] {
  const allowed = selected ? new Set<string>(selected) : undefined;
  const visible = actions.filter((item) => !allowed || allowed.has(item.action));
  const width = visible.reduce((maximum, item) => Math.max(maximum, item.syntax.length), 0);
  return visible.map((item) => `${item.syntax.padEnd(width)}  ${item.help ?? item.description}`);
}

export function renderUsage<Action extends string>(
  actions: readonly CommandActionSpec<Action>[],
  selected?: readonly Action[],
): string {
  const allowed = selected ? new Set<string>(selected) : undefined;
  const syntaxes = actions.filter((item) => !allowed || allowed.has(item.action)).map((item) => item.syntax);
  return `Usage: ${syntaxes.join(" or ")}`;
}

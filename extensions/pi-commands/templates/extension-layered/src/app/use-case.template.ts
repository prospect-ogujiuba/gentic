import type { {{pascalName}}State } from "../domain/types.ts";

export function describe{{pascalName}}State(state: {{pascalName}}State): string {
  return state.enabled ? "{{enabledText}}" : "{{disabledText}}";
}

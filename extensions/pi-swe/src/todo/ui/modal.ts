import type { TodoCoreState } from "../state-core.ts";
import { projectStandaloneTodoView } from "./docket.ts";
import { TodoDocketModal } from "./shared-modal.ts";
import type { TodoTheme } from "./theme.ts";

type LightweightTodoModalOptions = {
  state: TodoCoreState;
  theme: TodoTheme;
  requestRender: () => void;
  close: () => void;
  terminalRows: () => number;
};

/** Compatibility constructor backed by the shared provider-neutral modal. */
export class LightweightTodoModal extends TodoDocketModal {
  constructor(options: LightweightTodoModalOptions) {
    super({ ...options, view: projectStandaloneTodoView(options.state) });
  }
}

export { TodoDocketModal } from "./shared-modal.ts";

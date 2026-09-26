import type { TodoCoreState } from "../domain/state-core.ts";
import { projectStandaloneTodoView } from "./docket.ts";
import { TodoDocketModal } from "../../../../src/ui/todo-view/modal.ts";
import type { TodoTheme } from "../../../../src/ui/todo-view/theme.ts";

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

export { TodoDocketModal } from "../../../../src/ui/todo-view/modal.ts";

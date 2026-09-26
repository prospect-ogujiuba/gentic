import { DocketModal } from "../docket-kit/modal.ts";
import type { TodoView } from "../../todo-contracts/provider.ts";
import { renderSharedDocketLines, visibleTodoViewItems } from "./docket.ts";
import type { TodoTheme } from "./theme.ts";

export type TodoDocketModalOptions = {
  view: TodoView;
  theme: TodoTheme;
  requestRender: () => void;
  close: () => void;
  terminalRows: () => number;
};

/** Domain projection adapter; all keyboard/frame mechanics live in docket-kit. */
export class TodoDocketModal extends DocketModal {
  constructor(options: TodoDocketModalOptions) {
    super({
      ...options,
      title: options.view.provider === "workflow" ? "SWE WORK DOCKET" : "TODO DOCKET",
      noun: options.view.provider === "workflow" ? "work" : "tasks",
      rows: (includeDone) => visibleTodoViewItems(options.view, includeDone),
      renderContent: (state) => renderSharedDocketLines(options.view, options.theme, state),
    });
  }
}

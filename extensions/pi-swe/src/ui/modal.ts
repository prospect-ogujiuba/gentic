import { TodoDocketModal } from "../../../../src/pi-todo/ui/shared-modal.ts";
import type { SweDocket } from "./docket.ts";
import type { SweTheme } from "./theme.ts";

type SweDocketModalOptions = {
  docket: SweDocket;
  theme: SweTheme;
  requestRender: () => void;
  close: () => void;
  terminalRows: () => number;
};

/** Compatibility constructor backed by the shared provider-neutral modal. */
export class SweDocketModal extends TodoDocketModal {
  constructor(options: SweDocketModalOptions) {
    super({
      view: options.docket,
      theme: options.theme,
      requestRender: options.requestRender,
      close: options.close,
      terminalRows: options.terminalRows,
    });
  }
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { describe{{pascalName}}State } from "../app/use-case.ts";
import { initial{{pascalName}}State } from "../domain/types.ts";
import { render{{pascalName}}Status } from "../ui/render.ts";

export function register{{pascalName}}(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const text = render{{pascalName}}Status(describe{{pascalName}}State(initial{{pascalName}}State));
    ctx.ui.setStatus("{{kebabName}}", text);
  });
}

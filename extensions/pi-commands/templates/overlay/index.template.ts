import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

class {{pascalName}}Overlay implements Component {
  private readonly close: () => void;
  constructor(close: () => void) { this.close = close; }
  render(width: number): string[] { return ["{{skillTitle}} (press any key to close)".slice(0, width)]; }
  invalidate(): void {}
  handleInput(): void { this.close(); }
}

export default function {{camelName}}(pi: ExtensionAPI): void {
  pi.registerCommand("{{kebabName}}", {
    description: "{{description}}",
    handler: async (_args, ctx) => {
      await ctx.ui.custom((_tui, _theme, _keybindings, done) => new {{pascalName}}Overlay(() => done(undefined)), { overlay: true });
    },
  });
}

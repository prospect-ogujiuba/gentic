# pi-primitives

Central extension for Gentic lightweight primitives.

Primitives are self-contained runtime modules under `primitives/`. Each primitive owns an `index.ts` entrypoint and may carry supporting markdown, scripts, config, or helper files beside it.

Use primitives for small, reusable Pi runtime building blocks that should apply across prompts and skills but do not need dedicated top-level extensions.

## Add a primitive

1. Create `primitives/<name>/index.ts`.
2. Export a default function with this shape:

   ```ts
   import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
   import type { PrimitiveContext } from "../../index.ts";

   export default function primitive(pi: ExtensionAPI, ctx: PrimitiveContext): void {
     // register hooks, commands, tools, or other lightweight behavior
   }
   ```

3. Put supporting files inside the same primitive directory.
4. Keep always-on prompt injection conditional when possible, using primitive-local trigger/config files instead of coupling to another extension.
5. Use `ctx.readText("file.md")` to read primitive-local text files, or `ctx.path("file")` when a primitive needs a safe local path.
6. Primitive names are loaded alphabetically; prefix names with numbers only when order matters.
7. Run `/reload` in pi.

Keep prompt templates and skills focused on their local workflow; use primitives for shared runtime behavior instead of duplicating it.

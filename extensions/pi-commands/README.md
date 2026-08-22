# pi-commands

Central extension for Gentic slash commands.

## Anatomy

- **Mode:** `simple`
- **Public entry:** `index.ts`
- **Layers:** `pi`, `resources`
- **Resources:** `commands/`
- **Machine declaration:** optional handwritten `extension.anatomy.json`

## Scaffold

`/scaffold` previews by default and writes only with `--apply`. It resolves the nearest ancestor `package.json` containing a `pi` manifest from `ctx.cwd`; installed Gentic therefore scaffolds the active project, while self-host development resolves this repository. Non-Pi roots are refused.

Supported kinds: minimal/layered extension, tool, command, event, shortcut, flag, provider, widget, footer, overlay, skill, prompt, theme, and retained primitive.

Apply uses staged sibling files and a rollback transaction. Existing targets are never overwritten. Native registrations are standalone Pi extensions, so scaffolding does not edit a TypeScript barrel with regexes.

Run `node --experimental-strip-types --test test/pi-commands-scaffold.test.ts` for golden previews, every-step rollback injection, typechecking, and smoke loading.

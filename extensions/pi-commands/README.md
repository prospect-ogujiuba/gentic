# pi-commands

Central extension for Gentic slash commands.

## Add a command

1. Create `commands/<name>.ts` exporting a `PiCommandModule`.
2. Add it to `commands/index.ts`.

Keep command implementations small and focused; shared helpers can live alongside `types.ts` as this extension grows.

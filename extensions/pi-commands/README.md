# pi-commands

Central extension for Gentic slash commands.

## Anatomy

- **Mode:** `simple`
- **Public entry:** `index.ts`
- **Layers:** `pi`, `resources`
- **Resources:** `commands/`
- **Machine declaration:** `extension.anatomy.json`
- **Reference role:** simple hub example; no `src/*` layer folders are needed while command registration stays shallow.
- **Mismatch notes:** none; commands live in `commands/` and shared command types stay beside the entrypoint.

## Add a command

1. Create `commands/<name>.ts` exporting a `PiCommandModule`.
2. Add it to `commands/index.ts`.

Keep command implementations small and focused; shared helpers can live alongside `types.ts` as this extension grows.

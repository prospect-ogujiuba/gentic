# extension

Pi extension modules loaded from the Gentic suite.

## Discovery

Extensions live at `extensions/extension/<name>/index.ts`. Put helper files beside that `index.ts`.

## Example Gentic extensions

- **Suite Loader** — coordinates multiple Gentic extension modules as one package surface.
- **Capability Bundle** — groups commands, tools, and event hooks behind a single extension entrypoint.
- **Workspace Adapter** — loads project-specific Gentic behavior based on the current working directory.

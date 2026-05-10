# tool

Custom LLM-callable tools.

## Discovery

Extensions live at `extensions/tool/<name>/index.ts`. Put helper files beside that `index.ts`.

## Example Gentic extensions

- **Project Search Tool** — lets the model query a project index with structured arguments.
- **Patch Preview Tool** — generates and returns a proposed edit without applying it.
- **Dependency Insight Tool** — inspects package manifests and reports dependency relationships.

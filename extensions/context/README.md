# context

Context discovery, transformation, pruning, and injection surfaces.

## Discovery

Extensions live at `extensions/context/<name>/index.ts`. Put helper files beside that `index.ts`.

## Example Gentic extensions

- **Repo Context Injector** — adds repository facts to the system prompt at turn start.
- **Noise Pruner** — removes low-value generated output from model context.
- **Policy Context Layer** — appends project rules based on detected files.

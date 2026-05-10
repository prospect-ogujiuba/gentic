# event

Lifecycle and agent event handlers.

## Discovery

Extensions live at `extensions/event/<name>/index.ts`. Put helper files beside that `index.ts`.

## Example Gentic extensions

- **Audit Event Hook** — records selected lifecycle events to a local audit stream.
- **Safety Event Hook** — blocks risky tool calls before execution.
- **Context Event Hook** — trims or annotates model context before provider requests.

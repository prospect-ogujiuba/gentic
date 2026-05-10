# event-bus

Cross-extension event coordination patterns.

## Discovery

Extensions live at `extensions/event-bus/<name>/index.ts`. Put helper files beside that `index.ts`.

## Example Gentic extensions

- **Surface Signal Bus** — lets Gentic extensions publish lightweight internal signals.
- **Workflow Coordinator** — coordinates multi-extension workflows without direct imports.
- **Telemetry Relay** — normalizes extension events before sending them to a sink.

# provider

Custom provider registration.

## Discovery

Extensions live at `extensions/provider/<name>/index.ts`. Put helper files beside that `index.ts`.

## Example Gentic extensions

- **Local Provider** — registers a local OpenAI-compatible model endpoint.
- **Gateway Provider** — routes models through an internal gateway.
- **Fallback Provider** — exposes fallback models with Gentic defaults.

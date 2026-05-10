# tool-control

Tool activation, policy, interception, and result mutation.

## Discovery

Extensions live at `extensions/tool-control/<name>/index.ts`. Put helper files beside that `index.ts`.

## Example Gentic extensions

- **Danger Gate** — asks for confirmation before destructive shell commands.
- **Tool Allowlist** — limits active tools for sensitive workflows.
- **Result Sanitizer** — redacts secrets from tool results before context insertion.

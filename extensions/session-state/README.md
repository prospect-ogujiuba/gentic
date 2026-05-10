# session-state

Session persistence via custom entries and session metadata.

## Discovery

Extensions live at `extensions/session-state/<name>/index.ts`. Put helper files beside that `index.ts`.

## Example Gentic extensions

- **Workflow State** — persists Gentic workflow progress as custom session entries.
- **Preference Snapshot** — records per-session Gentic preferences.
- **Migration Marker** — stores schema migration status for Gentic data.

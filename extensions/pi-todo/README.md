# pi-todo

pi-todo is the Gentic todo ledger extension. It keeps agents on durable, claimable work and blocks non-todo tools until work is active.

Deterministic agent defaults:

- Use `todo({ "action": "begin" })` when no todo is active. It returns active work or starts the next ready todo.
- Use `todo({ "action": "finish", "summary": "..." })` to close active work. Existing attached evidence counts toward completion.
- Use `create_artifact` or `note_artifact` for generated durable notes/reports/plans so pi-todo creates the `.model-artifacts/<kind>/<topic>/...` path and attaches evidence automatically.
- Use `record_artifact` only for existing files.

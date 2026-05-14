# pi-todo

pi-todo is the Gentic todo ledger extension. It keeps agents on durable, claimable work and blocks non-todo tools until work is active.

Deterministic agent defaults:

- Use `todo({ "action": "begin" })` when no todo is active. It returns active work or starts the next ready todo.
- Use `todo({ "action": "finish", "summary": "..." })` to close active work. Existing attached evidence counts toward completion.
- Use `create_artifact` or `note_artifact` for generated durable notes/reports/plans so pi-todo creates the `.model-artifacts/<kind>/<topic>/...` path and attaches evidence automatically.
- Use `record_artifact` only for existing files.

## Intake organization and splitting

By default, `todo({ "action": "create", ... })` runs organized intake before persistence:

- Atomic requests create one directly workable todo.
- Compound requests are organized into a parent/container plus child todos in the same response. The parent records the decomposition and is not directly workable; start or begin a child todo instead.
- Vague requests return clarification questions instead of creating an underspecified todo.

Use `todo({ "action": "split_check", "todoId": "..." })` to diagnose an already-created todo, and `todo({ "action": "split", "todoId": "...", "children": [...] })` when complexity is discovered after creation. To intentionally preserve legacy create behavior, pass `"autoOrganize": false`.

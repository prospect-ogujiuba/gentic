# pi-todo

`pi-todo` is the Gentic todo-ledger extension. It provides a durable event-sourced task workflow, a TUI dashboard/widget, and enforcement that asks agents to claim or start a todo before using other tools.

## Orientation block

- **What it does:** manages todo creation, lifecycle transitions, splitting policy, dependency/claim readiness, evidence, generated artifacts, dashboard rendering, and todo-first enforcement.
- **Commands/tools it registers:** `todo` model-callable tool with create/update/split/split_check/list/get/next/claim/start/block/complete/attach_evidence/record_artifact/create_artifact/verify/reopen/history/graph and related actions; `/todo` command for the dashboard plus `list`, `next`, `graph <id>`, `history <id>`, `get <id>`, and `split-check <id>`.
- **Pi events it listens to:** `session_start` refreshes widget state and session naming; `turn_end` refreshes widget state; `tool_call` blocks non-`todo` tools until an active todo exists.
- **State/config files it reads/writes:** stores todo events in Pi session entries with custom type `gentic.todo.event`; generated artifacts are written under `.model-artifacts/<kind>/<topic>/`, with todo artifacts under `.model-artifacts/todo/<topic>/`; no standalone config file is currently read.
- **Internal module map:** `index.ts` wires Pi events, tool schemas, command handling, and widgets; `src/app/service.ts` owns lifecycle operations and artifact creation; `src/app/query.ts` summarizes and selects todos; `src/domain/*` defines types, reducer, lifecycle, policy, and split assessment; `src/pi/*` adapts Pi session storage and session naming; `src/ui/*` renders docket/modal/theme output.
- **Tests to run:** `npm test -- test/pi-todo.test.ts test/pi-todo-blocked.test.ts test/pi-todo-ledger-soul.test.ts test/pi-todo-modal-view.test.ts test/pi-todo-renderer.test.ts test/pi-todo-session-name.test.ts test/pi-todo-splitting.test.ts` or the full `npm test` suite.
- **Known boundaries/non-goals:** the ledger is session-entry backed, not an external database; generated artifacts must stay under approved `.model-artifacts/` folders; enforcement is intentionally about todo workflow, not command safety.

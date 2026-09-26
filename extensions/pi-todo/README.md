# pi-todo

pi-todo is the independently discovered owner of the `todo` command and structured tool. It provides two canonical lightweight authorities without requiring pi-swe:

- **session** — fork-aware `gentic.todo.event` entries reconstructed from the active Pi session branch.
- **project** — repository-root `.pi-todos.json`, with bounded schema validation, locking, compare-and-swap publication, and explicit `scope: "project"` mutations.

Unscoped operations use session Todo unless an optional focused workflow provider is available. Explicit `session`, `project`, `initiative`, and read-only `all` scopes preserve the public surface. Session and project state are never synchronized or promoted into workflow state.

## Implementation ownership

`index.ts` is the native Pi discovery entrypoint; all Todo-specific implementation lives inside this extension:

- `src/domain/state-core.ts` — session event validation, replay, and state transitions.
- `src/app/project-store.ts` and `project-backend.ts` — project persistence and session/project backend adaptation.
- `src/pi/register.ts`, `todo-surface.ts`, and `command-adapter.ts` — event integration, command/tool registration, scope selection, and command parsing.
- `src/ui/docket.ts` and `modal.ts` — standalone Todo state-to-view presentation adapters.

Root `src/todo-contracts/` contains only the shared request, view/backend, and event contracts consumed by Todo and SWE. Root `src/ui/todo-view/` renders those shared views without registration or persistence; `src/ui/docket-kit/` supplies generic terminal mechanics. Neither shared area imports extension implementations. SWE's workflow adapter remains owned by `extensions/pi-swe/integrations/todo.ts`.

## Optional pi-swe projection

The entrypoint communicates through Pi's native `pi.events` bus and the public contract in `src/todo-contracts/workflow-integration.ts`. A request/announcement handshake makes discovery independent of extension registration order and lets either extension run alone. Focus-change notifications refresh Todo presentation without transferring mutation authority.

When pi-swe is present and has a focused active initiative, Todo reads a direct workflow projection. The adapter permits only `start` and `finish`; `finish` maps to `SweService.markImplemented`, never completion or evidence. Structural changes require intentional `swe revise`. Missing, malformed, or unreadable focused workflow authority fails closed instead of falling back to session writes.

pi-todo never imports pi-swe implementation files. pi-swe never registers the Todo command/tool or owns session/project Todo persistence. `src/ui/docket-kit/` remains presentation-only.

## Verification

Ownership tests enforce extension-local implementation and prohibit shared-to-extension and private SWE-to-Todo imports. Focused coverage includes standalone loading, both extension load orders, focus refresh, absent integration, malformed authority, denied authority crossings, project persistence, session fork/restart replay, and bounded UI. Repository qualification uses `npm run typecheck`, `npm run check`, `npm run check:commands`, and `npm test`.

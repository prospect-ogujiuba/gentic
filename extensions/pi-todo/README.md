# pi-todo

pi-todo is a small branch-aware focus list. It keeps at most one todo active and leaves multi-step software workflow ownership to pi-swe.

## Public actions

| Action | Behavior |
|---|---|
| `create` | Add a ready todo with a concise title. |
| `start` | Make one ready todo active. Fails while another todo is active. |
| `finish` | Complete the selected or active todo. |
| `block` | Mark the selected or active todo externally blocked with a reason. |
| `unblock` | Return a blocked todo to ready. |
| `list` | Inspect all todos reconstructed from the active session branch. |

The `/todo` command exposes the same operations. A compact footer status names active work or reports the open count. In TUI mode, a persistent themed docket restores the visual task summary, active focus chip, progress bar, indented checkbox rows, and blocked-reason rails. `/todo open` opens a responsive keyboard-navigable modal with open/all filtering, scrolling, and expandable details.

## State and ownership

State is reconstructed in one pass over `sessionManager.getBranch()`. Public and legacy-replayed state is bounded to 1,000 todos; identifiers/text are single-line and bounded (title 256, ID 128, reason/summary 2,048 characters). Mutations append `gentic.todo.event` version-1 custom entries; queued cancellation is rechecked before append, and failed tool operations set `isError`. Loaded pi-swe can publish an optional activity probe through `src/lifecycle-coordination.ts`; pi-todo does not import SWE storage or scan initiative files. Probe failures fail closed for mutation while list remains available. Model calls intentionally check ownership both in the pre-execution hook and again inside queued execution. The duplicate check closes the state-change window. The presentation layer renders state without adding lifecycle behavior. The runtime has no scheduler, dependencies, claims, leases, splitting, artifact writing, configuration scan, reminder hooks, polling, or autonomous follow-up.

When loaded pi-swe reports active work, pi-swe is the lifecycle owner. `todo list` remains available; todo mutations are rejected. Conversely, pi-swe uses the shared todo lifecycle probe to reject activation while a todo is active.

## Migration and rollback

The lightweight reader accepts the essential version-1 events written by the former ledger: `todo.created`, `todo.started`, `todo.blocked`/`todo.external_blocked`, `todo.unblocked`, and `todo.completed`. Removed orchestration events are ignored. New events retain the same envelope and event names; completed events include an empty `evidence` array so the previous reader can consume them if the package revision is rolled back.

Removed actions are intentionally unavailable. Before upgrading, finish or block any work that depends on scheduling, leases, splitting, or artifact actions. A code rollback restores the former surface without rewriting session history.

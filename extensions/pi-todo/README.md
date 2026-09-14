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

State is reconstructed in one pass over `sessionManager.getBranch()`. Mutations append `gentic.todo.event` version-1 custom entries. The presentation layer renders that state without adding lifecycle behavior. The runtime has no scheduler, dependencies, claims, leases, splitting, artifact writing, configuration scan, startup filesystem scan, reminder hooks, polling, or autonomous follow-up.

When an assessed pi-swe task is active, pi-swe is the lifecycle owner. `todo list` remains available; todo mutations are rejected. Conversely, pi-swe uses the shared lifecycle probe to reject activation while a todo is active.

## Migration and rollback

The lightweight reader accepts the essential version-1 events written by the former ledger: `todo.created`, `todo.started`, `todo.blocked`/`todo.external_blocked`, `todo.unblocked`, and `todo.completed`. Removed orchestration events are ignored. New events retain the same envelope and event names; completed events include an empty `evidence` array so the previous reader can consume them if the package revision is rolled back.

Removed actions are intentionally unavailable. Before upgrading, finish or block any work that depends on scheduling, leases, splitting, or artifact actions. A code rollback restores the former surface without rewriting session history.

# 2. `pi-swe` — Todo boundary separated

> Shared review context: [overall verdict, comparison table, and priority order](./README.md).

## Current verdict

**Separated ownership; optional integration remains explicit**

The original review found that pi-swe owned durable initiative lifecycle, verification, context, UI, standalone Todo, and workflow-backed Todo through one discovery entrypoint. Disabling pi-swe therefore removed lightweight Todo even though Todo was not an SWE implementation detail.

## Implemented boundary

The package now discovers two extension entrypoints:

- `extensions/pi-swe/index.ts` registers only `swe` and owns workflow lifecycle, evidence, review, completion, focus, and continuation.
- `extensions/pi-todo/index.ts` registers only `todo` and owns session/project Todo persistence and mutation.

Either extension works when the other is absent. Their optional focused-work integration uses Pi's native `pi.events` bus and the provider-neutral public contract in `src/todo-contracts/workflow-integration.ts`. A request/announcement handshake supports both load orders, while focus-change events refresh Todo presentation. Neither extension imports the other's private implementation, and there is no shared registry or second ledger.

`extensions/pi-swe/integrations/todo.ts` is a projection adapter owned by pi-swe. It exposes only workflow status, `start`, and Todo `finish` mapped to `markImplemented`. Verification, evidence, work completion, and initiative completion remain inaccessible to Todo.

Todo's implementation lives in `extensions/pi-todo/src/{domain,app,pi,ui}/`, not behind a root-source facade. The shared `src/todo-contracts/` contains only request, backend/view, and event contracts. `src/ui/todo-view/` renders those shared views for both extensions; `src/ui/docket-kit/` owns generic terminal mechanics. Neither shared UI area has lifecycle, persistence, session, or service authority.

## Preserved behavior

The split retains public `swe`/`todo` names, session/project/initiative/all Todo selection, branch fork and restart replay, project persistence, malformed focused-authority fail-closed behavior, and bounded TUI/non-TUI output. Tests exercise each extension alone, both registration orders, focus refresh, absent integration, and denied authority crossings.

## Related priority

This completes priority **#2** in the [shared priority order](./README.md#priority-order).

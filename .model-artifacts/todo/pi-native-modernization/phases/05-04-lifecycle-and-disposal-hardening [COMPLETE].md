# Phase 5.4: Lifecycle and disposal hardening

Created: 2026-08-21
Purpose: Make every HUD surface and pending operation safe across reload, session switching, fork, and shutdown.

## Goal

Centralize idempotent lifecycle control so no timer, component, subscription, modal, or asynchronous refresh survives its owning session generation.

## Scope

- Define one runtime owner for footer, widget, status, timers, modal state, subscriptions, abort controllers, debounce work, and snapshot service.
- Refresh on `agent_settled` and `session_info_changed` with Phase 5.2 coalescing/debounce behavior.
- Fully reset state on every `session_start` and `session_shutdown`.
- Cover reload, new, resume, fork, and clone lifecycle sequences.
- Make cleanup idempotent and safe before initialization, during pending work, and after partial setup failure.
- Ensure modal/component references are discarded after disposal and recreated per opening.

## Outputs

- Central lifecycle/disposal owner and cleanup contract.
- Event registration consistent with documented Pi lifecycle order.
- Repeated lifecycle and open-handle regression tests.

## Acceptance criteria

- Shutdown clears footer, widget, status, timers, modal, subscriptions, queued debounce work, and pending snapshots.
- Repeated cleanup calls produce no error or duplicate side effect.
- Late async completion cannot update a new or shut-down session generation.
- Each session start begins from a clean state regardless of the preceding switch/fork path.
- Event registrations do not accumulate after reload.
- No stale component reference is reused after Pi disposes an overlay.

## Verification

- Repeated reload/new/resume/fork/clone sequence tests.
- Timer and open-handle detection after shutdown.
- Partial-initialization failure followed by cleanup and restart.
- Pending snapshot plus immediate shutdown/reset test.
- Modal open/close/reopen/dispose regression test.

## Decisions

- Pi 0.84.2 exposes reload through `session_shutdown(reason: "reload")` followed by rebound `session_start(reason: "reload")`; there is no separate extension-reload lifecycle hook needed by pi-hud.
- New/resume/fork replacement follows the same shutdown/rebind/start contract; clone is represented by the `fork` reason.
- `src/pi/runtime.ts` is the sole session-generation owner for surface cleanup, reserved status key, modal identity, and snapshot publication.
- Session start and shutdown reset configuration as well as transient state, matching Pi's extension rebind behavior.

## Completion evidence

- Lifecycle regression tests: `test/pi-hud-lifecycle.test.ts` cover cleanup before initialization, idempotence, full state reset, pending/late refresh rejection, partial setup failure and restart, reload/new/resume/fork/clone sequences, singular registrations, modal shutdown/close/reopen, and post-shutdown inactivity.
- Focused pi-hud tests pass 41/41; `npm run typecheck`, `npm run check`, and the full 291-test suite pass.
- Lifecycle ownership and Pi event-order behavior are documented in `extensions/pi-hud/README.md`.

## Non-goals

- No visual redesign.
- No gate/todo reminder policy changes.
- No generic lifecycle framework for unrelated extensions.

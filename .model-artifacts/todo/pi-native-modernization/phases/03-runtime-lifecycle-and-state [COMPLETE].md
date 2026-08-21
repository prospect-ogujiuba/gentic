# Phase 3: Runtime lifecycle and state

Created: 2026-08-21
Purpose: Make stateful extensions correct across turns, sessions, reloads, resumes, forks, tree navigation, compaction, and shutdown.

## Goal

Use current Pi lifecycle events and active-branch persistence semantics for `pi-context`, `pi-swe`, and `pi-todo`.

## Scope

- `pi-todo`: reconstruct from `sessionManager.getBranch()`, not whole-tree `getEntries()`; add versioned runtime-decoded event envelopes.
- `pi-todo`: define fork/tree/compaction behavior and unknown future-version policy.
- `pi-context`: correct input turn attribution and monotonic tool-event aggregation; reset closure state on start/shutdown.
- `pi-context`: throttle streaming updates and distinguish uncollected events from no activity.
- `pi-swe`: persist only required cross-turn state through native entries/details; correct topic reconstruction.
- `pi-swe`: successful scoped verification only; unrelated or failed evidence remains evidence but does not clear verification warnings.
- Add relevant `session_info_changed` and `agent_settled` handling.

## Outputs

- Versioned state contracts and migration behavior.
- Active-branch reconstruction tests.
- Explicit lifecycle tables per extension.
- Correct verification/evidence policy.

## Acceptance criteria

- Abandoned branch todo/SWE events never affect the active branch.
- Reload/resume/fork/tree tests reconstruct deterministic state.
- Failed verification does not satisfy SWE verification.
- `pi-context` preserves arguments/paths across the full tool lifecycle and does not assign new input to the prior turn.
- Session shutdown leaves no stale in-memory state.

## Verification

- Realistic fake/actual `SessionManager` trees with branch divergence.
- Event-order tests matching current Pi documentation.
- Compaction and session replacement smoke tests.
- Performance test or bound for `message_update` hot paths.

## Open questions

- Which state must persist versus remain turn-local?
- How much event history should compaction retain?

## Non-goals

- No UI redesign.
- No gate shell-policy work.

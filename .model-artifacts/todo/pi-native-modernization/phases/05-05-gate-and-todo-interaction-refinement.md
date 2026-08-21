# Phase 5.5: Gate and todo interaction refinement

Created: 2026-08-21
Purpose: Make gate prompts and todo reminders safe, mode-aware, actionable, and free of surprise duplicate agent turns.

## Goal

Refine adjacent interaction surfaces so cancellation, timeout, reload, and no-UI operation have explicit safe behavior without excessive ceremony.

## Scope

- Make gate prompts timeout and cancellation aware with deny/safe defaults.
- Distinguish TUI dialogs, RPC dialogs, and no-UI behavior using `ctx.mode` and `ctx.hasUI`.
- Refine todo docket, dashboard, widget, and final reminder content for concise actionable output.
- Prevent reminder rendering or reload recovery from enqueueing duplicate model turns.
- Clear prompt/modal/reminder state on lifecycle teardown.
- Preserve strict todo enforcement semantics while reducing non-actionable UI noise.

## Outputs

- Explicit gate prompt outcome contract for allow, deny, cancel, timeout, unavailable UI, and error.
- Mode-aware todo display/reminder policy.
- Duplicate-turn and reload regression tests.
- Updated gate and todo interaction documentation.

## Acceptance criteria

- Gate cancellation, timeout, missing UI, and prompt error resolve to the documented safe result.
- TUI-only components are never invoked in RPC, JSON, or print modes.
- RPC uses only supported dialog/fire-and-forget APIs.
- Todo reminders identify the exact actionable task or deterministic repair action.
- Reload and lifecycle replay cannot emit the same reminder or enqueue a duplicate turn twice.
- Display-only activity never mutates todo lifecycle state.

## Verification

- Gate matrix tests for mode × allow/deny/cancel/timeout/error outcomes.
- Todo tests for empty, ready, blocked, active, completed, and stale-reload states.
- Duplicate-turn spy test across reload and repeated settled events.
- TUI, RPC, JSON, and print smoke tests.

## Open questions

- Decide whether final reminders are widgets, notifications, status text, or plain tool output in each supported mode.

## Non-goals

- No change to gate policy evaluation or remembered-rule semantics.
- No todo ledger schema or lifecycle redesign.
- No new autonomous follow-up mechanism.

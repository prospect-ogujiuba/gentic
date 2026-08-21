# Phase 5: UI modernization

Created: 2026-08-21
Purpose: Make Gentic UI composable with Pi's native footer/status/widget behavior and reliable across modes and lifecycle teardown.

## Goal

Provide useful UI without hiding native information, blocking hot events, or leaking timers/components.

## Scope

- Define `pi-hud` modes: off, widget-first, footer replacement, modal.
- Make widget-first or explicit opt-in the interoperability-safe default.
- If footer replacement remains, consume native `footerData`, statuses, and branch subscriptions.
- Replace synchronous Git polling on hot hooks with cancellable cached async snapshots and debounce.
- Refresh on `agent_settled`/`session_info_changed`; fully reset state on start/shutdown.
- Add idempotent modal/component disposal.
- Make gate prompts timeout/cancel aware and default safely.
- Refine todo docket/dashboard/final reminders to avoid surprise extra turns and excessive ceremony.
- Adapt output for TUI, print, JSON, and RPC via `ctx.mode`/`ctx.hasUI`.

## Implementation order

1. [05-01-ui-ownership-and-mode-contract.md](05-01-ui-ownership-and-mode-contract.md)
2. [05-02-async-cached-snapshot-service.md](05-02-async-cached-snapshot-service.md)
3. [05-03-surface-ownership-and-responsive-rendering.md](05-03-surface-ownership-and-responsive-rendering.md)
4. [05-04-lifecycle-and-disposal-hardening.md](05-04-lifecycle-and-disposal-hardening.md)
5. [05-05-gate-and-todo-interaction-refinement.md](05-05-gate-and-todo-interaction-refinement.md)

Each slice is an independent `swe-implement` contract. Run `swe-dsa` before Slice 5.2, then verify each slice before advancing.

## Outputs

- UI ownership and conflict policy.
- Mode-aware display settings.
- Cached snapshot service and cleanup contracts.
- Responsive rendering tests.

## Acceptance criteria

- Native statuses remain visible or footer replacement is clearly opt-in.
- No synchronous process runs in high-frequency HUD event handlers.
- Shutdown/reload clears footer, widget, timers, modal, and pending work.
- No-UI modes do not invoke custom TUI.
- Todo/gate reminders are actionable and do not trigger duplicate turns after reload.

## Verification

- Golden renders at narrow, medium, and wide widths.
- TUI and no-UI smoke tests.
- Repeated reload/new/resume/fork teardown test with timer/open-handle detection.
- Slow Git repository simulation proving event loop remains responsive.

## Open questions

- Is footer replacement a core Gentic identity or an optional profile?
- Which native footer fields must always be preserved?

## Non-goals

- No catalog/scaffold redesign.

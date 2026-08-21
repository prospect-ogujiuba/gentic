# Phase 5.1: UI ownership and mode contract

Created: 2026-08-21
Purpose: Define which Gentic surface owns UI in each Pi runtime mode before changing rendering or lifecycle behavior.

## Goal

Establish a validated, documented display-mode contract that preserves Pi-native information and never invokes unsupported UI APIs.

## Scope

- Define `pi-hud` display modes: `off`, `widget-first`, `footer`, and on-demand `modal`.
- Make `widget-first` the proposed interoperability-safe default; keep footer replacement explicit opt-in.
- Route behavior by `ctx.mode`: full components only in TUI, widget/status requests in RPC, and no custom UI in print/JSON.
- Define ownership and conflict behavior for footer, widgets, statuses, working indicator, and modal surfaces.
- Add configuration validation and migration behavior for existing settings.
- Document the mode matrix in `extensions/pi-hud/README.md`.

## Outputs

- Typed and validated display-mode configuration.
- UI ownership/conflict policy and runtime mode matrix.
- Focused configuration and mode-routing tests.

## Acceptance criteria

- Every display mode has one documented owner and cleanup path for each UI surface it touches.
- Footer replacement is disabled unless explicitly configured.
- `ctx.mode === "tui"` gates `custom()` and component factories.
- RPC uses only supported fire-and-forget widget/status APIs.
- Print and JSON modes do not invoke custom UI.
- Invalid configuration fails predictably or uses a documented safe fallback.

## Verification

- Table-driven tests covering every display mode across TUI, RPC, JSON, and print.
- Configuration fixtures for absent, valid, invalid, and legacy values.
- Typecheck and focused `pi-hud` usage tests.

## Decisions

- `widget-first` is the default user-visible behavior; footer replacement remains explicit opt-in.
- `modal` is an on-demand TUI command, not a persistent configuration mode.
- Invalid configuration throws `TypeError`; absent configuration and reset use `widget-first`; legacy `widget`/`both` placements migrate to `widget-first`.

## Completion evidence

- Runtime/configuration tests: `test/pi-hud-mode-contract.test.ts`.
- Focused pi-hud tests, `npm run typecheck`, `npm run check`, and the full 273-test suite pass.
- Ownership, cleanup, conflict, migration, and runtime matrices are documented in `extensions/pi-hud/README.md`.

## Non-goals

- No Git snapshot refactor.
- No responsive renderer redesign.
- No gate or todo reminder changes.

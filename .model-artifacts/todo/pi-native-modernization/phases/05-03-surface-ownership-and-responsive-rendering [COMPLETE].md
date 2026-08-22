# Phase 5.3: Surface ownership and responsive rendering

Created: 2026-08-21
Purpose: Render the HUD through composable Pi-native surfaces without hiding branch or extension status information.

## Goal

Deliver widget-first rendering and an optional native-aware footer that remain useful at narrow, medium, and wide terminal widths.

## Scope

- Implement the Phase 5.1 ownership/mode contract using the Phase 5.2 snapshot service.
- Use a widget as the default persistent HUD surface when the proposed default is approved.
- In opt-in footer mode, consume `footerData.getGitBranch()`, `getExtensionStatuses()`, and `onBranchChange()`.
- Unsubscribe footer branch listeners through component disposal.
- Define deterministic priority, truncation, wrapping, and omission rules by width.
- Keep modal rendering on-demand and TUI-only.
- Preserve native statuses or render their equivalent in footer replacement mode.

## Outputs

- Widget-first and optional footer surface adapters.
- Native footer-data integration and subscription cleanup.
- Responsive render fixtures and golden expectations.
- Updated HUD usage documentation.

## Acceptance criteria

- Native extension statuses remain visible in the default mode.
- Footer replacement is opt-in and includes native branch and extension status data.
- Rendering never exceeds the supplied width after ANSI-aware measurement.
- Narrow layouts retain actionable/high-priority state and omit decorative detail first.
- Repeated render calls do not start processes, timers, or subscriptions.
- Modal construction occurs only in TUI mode and creates a fresh component per opening.

## Verification

- Golden renders at representative narrow, medium, and wide widths.
- Tests for empty, clean, dirty, error, long-branch, many-status, and Unicode/ANSI inputs.
- Footer branch-change subscription and disposal test.
- TUI and RPC surface smoke tests consistent with the Phase 5.1 matrix.

## Decisions

- Below 48 columns, omit recent-event decoration first and preserve model, Git/worktree, active-tool count, errors, and warnings.
- In footer replacement below 24 columns, preserve the first extension status, or the native branch when no status exists. At 24 columns and above, preserve a bounded branch segment plus a compact status summary.
- Medium layouts restore events and compact secondary detail; wide layouts use full fitting candidates.

## Completion evidence

- Responsive/native surface tests: `test/pi-hud-responsive-rendering.test.ts` cover narrow/medium/wide goldens, empty/clean/dirty/error/long/Unicode/ANSI inputs, many native statuses, branch subscription disposal, render side effects, and fresh modal construction.
- Focused pi-hud tests pass 36/36; `npm run typecheck`, `npm run check`, and the full 286-test suite pass.
- Ownership, native `footerData` integration, cleanup, and width-priority rules are documented in `extensions/pi-hud/README.md`.

## Non-goals

- No snapshot scheduling or cancellation redesign.
- No todo/gate interaction changes.
- No new theming system.

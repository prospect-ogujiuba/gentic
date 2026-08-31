# Phase 03: Lifecycle orchestration and command UX

Created: 2026-08-30
Purpose: Expose canonical state as deterministic stage recommendations and concise developer-facing status.

## Goal

Integrate the two-level lifecycle, make orchestration gate-aware and revision-safe, and upgrade `/swe` commands without adding hidden execution or a new namespace.

## Scope

Lifecycle domain transitions, orchestration view/recommendation, command parsing/formatting/completions, and focused command tests. Skill prose changes wait until Phase 04.

## Subphases

- `03.01` Two-level lifecycle integration
- `03.02` Gate-aware orchestration recommendations
- `03.03` Status and orchestration command UX

## Acceptance criteria

- Initiative and contract states are not conflated.
- Next-step guidance reads canonical gates and exact active contract.
- Stale/ambiguous/legacy/blocked cases produce deterministic handoffs.
- Commands accept optional topic while preserving current `/swe` namespace and guidance-only behavior.

## Verification

Focused lifecycle and command tests, `npm run test:swe`, `npm run typecheck`, and `npm run check` after Phase 03.

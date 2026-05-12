# Phase 7 — gradual migration and enforcement

Created: 2026-05-12
Purpose: Migrate existing extensions and promote stable anatomy checks carefully.

## Goal

Bring existing extension cores into the declared anatomy without broad, risky rewrites.

## Scope

- Migrate one extension per pull/slice.
- Start with low-risk structural improvements.
- Promote only stable, low-false-positive checker rules to failures.

## Proposed migration order

1. Keep `pi-todo` as reference; adjust only if documentation/checker reveals mismatch.
2. Clean up `pi-gate` into layered-lite shape.
3. Mark simple hubs: `pi-commands`, `pi-skills`, `pi-prompts`, `pi-primitives`.
4. Rework `gentic`, `pi-swe`, and `pi-hud` only with targeted behavior-preserving slices.
5. Revisit `pi-catalog` once scaffolding ownership is clear.

## Outputs

- Per-extension declaration and README orientation.
- Per-extension structural refactor only where useful.
- Checker rules moved from warning to failure when proven stable.

## Acceptance criteria

- Each migrated extension has a truthful declared mode.
- `index.ts` remains a thin adapter for layered extensions.
- Pure domain/app logic is testable without Pi runtime where applicable.
- No resource discovery regressions.

## Verification

- Run `npm run check`.
- Run full `npm test` after each extension migration.
- Run targeted tests for touched extension.
- Manual reload in Pi when command/skill/prompt discovery changes.

## Non-goals

- No mass refactor in one commit.
- No empty layer folders just to satisfy shape.
- No strict enforcement before declarations are complete and stable.

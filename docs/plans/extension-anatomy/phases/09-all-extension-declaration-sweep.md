# Phase 9 — all-extension declaration sweep

Created: 2026-05-12
Purpose: Declare anatomy for every existing extension after the format is proven.

## Goal

Give every existing extension an explicit `simple` or `layered` status.

## Scope

- Add anatomy declarations to all extension READMEs or metadata files.
- Capture transitional notes where current layout does not yet match desired target.
- Avoid behavior changes and structural refactors in this sweep.

## Outputs

- Declarations for every `extensions/*` package.
- Checker report with no missing-declaration warnings.
- Migration notes for extensions that need later structural work.

## Acceptance criteria

- Every extension has a declared mode.
- Declarations are truthful to current state or explicitly marked transitional.
- No runtime code changes are required for this phase.

## Verification

- Run anatomy checker.
- Expected evidence: zero missing declarations.
- Run `npm run check`.

## Non-goals

- No moving files between layers.
- No enforcing thin adapters beyond reporting.

# Phase 02: Artifact inspection, compatibility, and persisted state

Created: 2026-08-30
Purpose: Connect pure canonical planning invariants to repository artifacts without mixing legacy and canonical modes.

## Goal

Resolve canonical initiatives deterministically, isolate legacy adoption, and reconstruct resumable execution state whose pointers are validated against the active approved plan.

## Scope

Filesystem inspectors/adapters, topic resolution, runtime persistence/state migration, temporary-directory integration fixtures, and atomic mutable-state behavior. Command presentation remains Phase 03.

## Subphases

- `02.01` Canonical filesystem inspector
- `02.02` Legacy adapter and initiative resolver
- `02.03` Runtime persistence and active-contract state

## Acceptance criteria

- Manifest paths replace broad canonical filename heuristics.
- Ambiguous initiatives stop with actionable diagnostics.
- Legacy todo-phase plans are labelled unverified and cannot merge with canonical candidates.
- Persisted state cannot activate stale/wrong-revision contracts.
- pi-todo remains optional context only.

## Verification

Temporary filesystem fixtures, runtime state tests, `npm run test:swe`, and `npm run typecheck`.

## Risks

Path normalization and compatibility fallback can create security/correctness regressions; preserve repository-relative validation and characterize old discovery before replacement.

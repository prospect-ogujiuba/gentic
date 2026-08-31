# Phase 01: Canonical domain model and readiness invariants

Created: 2026-08-30
Purpose: Establish deterministic, testable planning primitives before filesystem, runtime, or command migration.

## Goal

Provide strict schema-v1 initiative/plan representations, dependency-graph validation, and explicit readiness gates that cannot infer approval from file presence.

## Scope

New pure domain modules under `extensions/pi-swe/src/domain/`, extension-local exports where needed, and focused tests. Do not change command output, skill documentation, or default artifact discovery in this phase.

## Subphases

- `01.01` Initiative manifest and revision schema
- `01.02` Contract dependency DAG and deterministic ready set
- `01.03` Specialist, approval, and readiness reducer

## Outputs

Typed discriminated unions, validators with actionable diagnostics, graph utilities, gate evaluation, and unit fixtures reusable by later filesystem/orchestration tests.

## Acceptance criteria

- Invalid identity, traversal, schema version, link, revision, and approval combinations fail deterministically.
- Contract graph rejects duplicate/missing/self/cyclic dependencies and returns stable order/readiness.
- Approval and contract readiness require explicit matching revision/gate evidence.
- Pure domain behavior has no filesystem, Pi API, or pi-todo dependency.

## Verification

Run each subphase's focused test, then `npm run test:swe` and `npm run typecheck` at phase completion.

## Non-goals

No manifest writes, legacy adoption, runtime persistence changes, or UI formatting.

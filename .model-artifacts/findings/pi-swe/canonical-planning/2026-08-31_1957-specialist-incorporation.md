# specialist-incorporation

Created: 2026-08-31T19:57:30.752Z
Purpose: Restore the specialist evidence referenced by the approved canonical planning initiative.

# Specialist incorporation: canonical pi-swe planning

Topic: `pi-swe/canonical-planning`
Spec: `.model-artifacts/specs/pi-swe/canonical-planning/2026-08-30_0331-initiative-spec-r2.md`
Plan: `.model-artifacts/plans/pi-swe/canonical-planning/2026-08-30_0333-plan-index-r1.md`
Decision: complete — incorporated into plan r1 contracts

## DSA

The dependency DAG, deterministic ordering, bounded local contract set, and linear graph validation are incorporated in 01.02, 01.03, and the plan dependency graph. No additional representation change is required.

## TDD

Each implementation contract defines a Red/characterization boundary and focused verification. Runtime Red evidence is restricted to implementation; planning does not claim executed failures. The 04.02 resource assertions cover approved-contract and evidence-mapping language.

## Migration

Legacy artifact adoption and rollback are incorporated in 02.02 and 04.03. Canonical adoption preserves legacy resolution as rollback when manifest/index state is removed.

## Operations

Atomic mutable state, resume behavior, active-contract state, bounded output, and exception handoff are incorporated in 02.03, 03.02, and 03.03.

## Compatibility

Existing skills, `/swe`, standalone operation, optional peers, and intentionally omitted legacy namespaces are preserved across 03.* and 04.*.

## Open findings

None blocking plan r1 approval.

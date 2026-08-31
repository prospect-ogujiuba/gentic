# Phase 04: Skill workflow, documentation, migration, and release verification

Created: 2026-08-30
Purpose: Make canonical planning the default developer workflow and prove it across standalone, optional-peer, migration, and resume scenarios.

## Goal

Upgrade all pi-swe skill contracts, document the canonical initiative process, provide explicit legacy adoption guidance, and complete repository-wide verification/review.

## Scope

Nine pi-swe skills, README, end-to-end scenarios, resource/document assertions, migration guidance/helpers justified by prior domain APIs, and final verification. No new command namespace or hidden autonomous implementation.

## Subphases

- `04.01` Planning and plan-review skill contracts
- `04.02` Execution, verification, review, and finalize skill contracts
- `04.03` Migration, scenarios, hardening, and final verification

## Acceptance criteria

- Planning produces reviewed phased/subphased contracts under plans, not canonical todo phases.
- Every skill reads/writes the right canonical artifacts and respects approval/revision gates.
- Legacy adoption and optional pi-todo behavior are explicit.
- Automated and manual coverage represent all required scenarios.
- Full repository verification and implementation review pass before handoff.

## Verification

Skill/resource assertions, `npm run test:swe`, `npm run typecheck`, `npm run check`, `npm test`, and documented manual scenario sampling.

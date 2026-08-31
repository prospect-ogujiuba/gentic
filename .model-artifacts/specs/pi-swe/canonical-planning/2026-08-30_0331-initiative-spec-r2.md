# Canonical pi-swe planning lifecycle — initiative specification r2

Created: 2026-08-30
Topic: `pi-swe/canonical-planning`
Revision: 2
Status: Approved specification

## Problem

The pi-swe workflow needs one durable, machine-readable initiative identity and an immutable revision chain so planning, execution, verification, review, resume, and finalization do not infer approval or scope from chat, todo state, or filenames.

## Outcomes and observable behavior

- One exact topic resolves through `.model-artifacts/specs/pi-swe/canonical-planning/manifest.json`.
- The manifest links immutable spec and plan revisions by path and `contentHash`.
- A dependency-indexed contract set yields deterministic ready, blocked, and complete states.
- Specialist applicability, plan review, approval, verification, implementation review, and final reconciliation are explicit gates.
- `/swe` and standalone skills report concise, artifact-oriented next actions and deterministic exception handoffs.
- Existing skill names, `/swe`, standalone operation, and legacy adoption remain compatible.

## Users

- Developers executing one approved contract.
- Reviewers validating exact revisions and evidence.
- Orchestrators resuming work across sessions.
- Maintainers migrating legacy pi-swe artifacts.

## Constraints and non-goals

- Preserve the existing public skill and `/swe` surfaces; introduce no legacy or autonomous namespace.
- Todo and peer extensions are optional context, never canonical approval.
- Keep changes surgical, deterministic, bounded, and filesystem-local.
- Do not add hidden autonomous execution, a remote state service, or a new workflow engine.

## Compatibility

Legacy plans may be adopted into the canonical manifest/index when their identity and revision links are made explicit. Existing skill discovery and standalone behavior must continue without pi-todo or other peers.

## Specialist applicability

| Specialist | Status | Rationale / incorporated evidence |
|---|---|---|
| diagnosis | not-required | Enhancement work has no runtime defect requiring diagnosis. |
| dsa | complete | Contract dependency DAG and deterministic ordering are incorporated in 01.02 and the r1 plan. |
| tdd | complete | Resource-contract Red/Green boundaries and verification ordering are incorporated in every subphase. |
| security | not-required | No auth or privilege boundary; path confinement is a correctness invariant. |
| migration | complete | Legacy adoption and migration are explicit in 02.02 and 04.03. |
| performance | not-required | Bounded local plans use linear graph and filesystem inspection. |
| accessibility-ux | not-required | Text-only output; concise deterministic messages are covered by 03.03. |
| operations | complete | Atomic state, resume, and exception handoff are incorporated in 02.03 and 03.02. |
| compatibility | complete | Existing commands, skills, legacy inputs, and standalone operation are contract requirements. |

## Acceptance criteria

- A valid manifest identifies the exact active spec, active plan, approval evidence, specialists, and optional active contract.
- `contracts.json` represents the dependency DAG, canonical paths/hashes, statuses, readiness facts, and consequential specialists.
- Stale paths, revisions, hashes, approvals, dependencies, blockers, or missing evidence produce deterministic remediation.
- Execution and review operate on one approved exact contract rather than chat, todo, or filename inference.
- Verification maps acceptance criteria to evidence, and finalization reconciles all contract dispositions and residual risk.
- Focused tests, `npm run test:swe`, resource checks, and typechecking pass for each applicable slice.

## Migration and rollback

Adopt legacy artifacts by creating the manifest and contract index without changing public command semantics. Preserve immutable source revisions. If canonical inspection regresses, remove the manifest/index adoption and return resolution to the existing legacy inspector while retaining the source plan documents.

## Risks

- Hash drift between mutable indexes and immutable artifacts.
- Completion renames making tracked contracts disappear behind `.model-artifacts/` ignore rules.
- Approval records becoming stale after plan or contract edits.
- Evidence being reported in chat but not linked to the exact contract revision.

## Open blockers

None at specification approval. Contract-local blockers are represented in the active contract index.

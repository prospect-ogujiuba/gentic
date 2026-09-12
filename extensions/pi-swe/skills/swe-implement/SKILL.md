---
name: swe-implement
description: Coordinate the complete direct/manual implementation lifecycle for one approved SWE contract while preserving surgical scope and independent verification/review gates.
---

# SWE Implement

Use this only for one execution-ready contract from an active approved plan. A todo, chat instruction, plan filename, or contract filename may locate work but is not sufficient approval.

For a direct/manual `/skill:swe-implement` request, this skill owns the bounded lifecycle from implementation through specialist execution guidance, verification, implementation review, and finalization handoff. When a guided work runner owns sequencing, perform only the runner-assigned stage and preserve its plan, state transitions, persistence, and next-stage decision; never replace, expand, or auto-advance a runner-owned plan.

## Execution gate

Before editing, read in order:

1. `.model-artifacts/initiatives/<topic>/specs/manifest.json` and its active spec and active approved plan paths.
2. `<activePlan.contractRoot>/contracts.json`, then the exact contract selected as ready.
3. The contract's dependencies, incorporated specialist findings, prior implementation/verification notes, and current repository and todo state when available.

Validate every `contentHash`, revision, and pointer. The manifest approval must match the active plan revision/path/hash; `contracts.json` must match the exact contract path/hash and mark it dependency- and gate-satisfied; predecessors must be complete; readiness facts, planned verifier, approved deferrals, and open blockers must agree. If `activeContract` exists it must name this contract; otherwise record execution start in current canonical state before editing.

Reject a stale revision, unsatisfied dependency, open blocker, missing verifier, mismatched hash/pointer, or conflicting change. Stop deterministically with the affected artifact/path, observed versus required state, and next action: refresh or revise via `/skill:swe-plan`, complete the named predecessor, resolve the blocker/verifier, or reconcile the conflicting path. Do not guess from chat or silently repair canonical state.

## Direct/manual lifecycle

For direct/manual use, keep one criterion ledger for the exact contract and follow these stages. A focused implementation check supports iteration but does not substitute for independent `swe-verify` evidence or implementation-review approval.

1. **Frame the contract** — restate the exact contract/revision, intended behavior, file scope and non-goals, every acceptance criterion, and planned verification.
2. **Read the slice** — read only target files and dependencies the exact contract requires; umbrella plans remain background, not expanded scope.
3. **Route applicable specialist work** — follow incorporated specialist decisions. Use `swe-diagnose` when a failure lacks a credible cause, `swe-dsa` when an in-contract representation or algorithm choice needs implementation-time validation, and `swe-tdd` when the next behavior should be proven first. Specialist output returns here unless it identifies a material contract change, which returns to `swe-plan`.
4. **Select the next criterion** — choose one unmet acceptance criterion and its smallest observable vertical behavior. Mark it `in-progress`; do not start later-contract work.
5. **Implement and check** — build the smallest honest slice through the relevant layers, update tests/docs required by the contract, and run the focused planned check. Record the criterion, changed paths, check, and result as `implemented-check-pass`, `fail`, `partial`, or `gap`.
6. **Repeat to contract coverage** — continue criteria one at a time until every in-scope criterion has an implementation result. Avoid opportunistic refactors, broad formatting, adjacent features, and future cases. Any unexplained repeated failure stops with preserved evidence rather than thrashing.
7. **Verify independently** — after all criteria are implemented with focused checks, follow `swe-verify` to build the authoritative acceptance-to-evidence map and run risk-scaled checks. A verification failure that is an understood in-contract defect returns here for one bounded correction, followed by reverification; stale plans, missing verifiers, or material drift return to `swe-plan`.
8. **Review independently** — after verification passes, follow `swe-review` in implementation-review mode. `request changes` returns here for one bounded in-contract correction, then requires reverification and rereview. `return to plan` stops implementation.
9. **Finalize** — only after current verification passes and implementation review approves, follow `swe-finalize` to reconcile evidence, canonical/todo state, residual risk, and the completion handoff. Do not claim completion earlier.

This workflow remains standalone when todo or peer extensions are unavailable. It coordinates existing skills through their documented handoffs; it does not create hidden autonomous execution or modify guided work runner behavior.

## Scope drift notes

Trivial implementation that stays within the assigned contract does not require a note file. When a note is useful, write it under:

`.model-artifacts/initiatives/<topic>/findings/YYYY-MM-DD_HHMM-implementation-notes.md`

Keep the note short and include at least:

- Original contract: exact canonical contract ID, path, revision, and `contentHash`, plus the promised behavior.
- Todo: optional link only, when available; it is not contract authority.
- Discovered drift: what changed, expanded, contradicted, or became blocked.
- Decision taken: stopped, implemented with confirmation, deferred, or narrowed.
- Follow-up slice: what should go back to `/skill:swe-plan`, a phase file update, or a new todo.
- Affected paths: files, commands, or areas touched or expected to change.

When a todo is active, also record the created artifact, drift note, or follow-up decision in the todo ledger when it materially changes handoff state.
After writing an artifact, keep chat output concise and path-oriented: artifact path, decision taken, follow-up slice, and affected paths.

## Handoff language

For drift that should return to planning, say exactly where it belongs: `/skill:swe-plan`, the named phase/implementation file, or a new todo. Include the affected paths and the smallest suggested follow-up slice.

## Success criteria

- Every in-scope acceptance criterion has an implementation result and focused check or an explicit blocking handoff.
- The change is narrow, coherent, and reversible.
- Applicable diagnosis, DSA, and TDD guidance is consumed without expanding the approved contract.
- Independent verification passes and implementation review approves before finalization.
- Any correction is followed by reverification and rereview where applicable.
- Scope drift is either not present, explicitly deferred, or recorded with a user-visible return to plan.
- Guided work runner plans and sequencing remain untouched.

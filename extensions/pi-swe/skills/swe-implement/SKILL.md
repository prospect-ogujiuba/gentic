---
name: swe-implement
description: Implement the smallest honest vertical SWE slice while preserving read-before-edit and surgical scope discipline.
---

# SWE Implement

Use this only for one execution-ready contract from an active approved plan. A todo, chat instruction, plan filename, or contract filename may locate work but is not sufficient approval.

## Execution gate

Before editing, read in order:

1. `.model-artifacts/specs/<topic>/manifest.json` and its active spec and active approved plan paths.
2. `<activePlan.contractRoot>/contracts.json`, then the exact contract selected as ready.
3. The contract's dependencies, incorporated specialist findings, prior implementation/verification notes, and current repository and todo state when available.

Validate every `contentHash`, revision, and pointer. The manifest approval must match the active plan revision/path/hash; `contracts.json` must match the exact contract path/hash and mark it dependency- and gate-satisfied; predecessors must be complete; readiness facts, planned verifier, approved deferrals, and open blockers must agree. If `activeContract` exists it must name this contract; otherwise record execution start in current canonical state before editing.

Reject a stale revision, unsatisfied dependency, open blocker, missing verifier, mismatched hash/pointer, or conflicting change. Stop deterministically with the affected artifact/path, observed versus required state, and next action: refresh or revise via `/skill:swe-plan`, complete the named predecessor, resolve the blocker/verifier, or reconcile the conflicting path. Do not guess from chat or silently repair canonical state.

## Workflow

1. Restate the exact contract/revision, intended behavior, file scope and non-goals, acceptance criteria, and planned verification.
2. Read only target files and dependencies the exact contract requires; umbrella plans remain background, not expanded scope.
3. Build the smallest honest vertical slice through the relevant layers.
4. Implement only the contract's acceptance criteria; preserve read-before-edit and surgical scope.
5. Avoid opportunistic refactors, broad formatting, adjacent features, later contracts, or next-slice work.
6. Update tests/docs only when required by this contract.
7. Use bounded retries: after one repeated unexplained failure, stop, preserve the evidence, and hand off instead of thrashing.
8. If implementation reveals scope drift, a material design change, a blocked follow-up, or a needed contract change, stop and return to plan revision; do not edit the approved contract in place.
9. Stop at a verifiable boundary and hand the exact contract, diff scope, and acceptance criteria to `swe-verify`.

This workflow remains standalone when todo or peer extensions are unavailable.

## Scope drift notes

Trivial implementation that stays within the assigned contract does not require a note file. When a note is useful, write it under:

`.model-artifacts/findings/<topic>/YYYY-MM-DD_HHMM-implementation-notes.md`

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

- The change is narrow, coherent, and reversible.
- The implementation can be verified directly.
- Scope drift is either not present, explicitly deferred, or recorded with a user-visible handoff.

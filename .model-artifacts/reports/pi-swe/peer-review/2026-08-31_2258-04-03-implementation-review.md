# 04-03-implementation-review

Created: 2026-08-31T22:58:43.646Z
Purpose: Implementation review of the frozen uncommitted diff for exact approved r6 contract 04.03.

# Contract 04.03 implementation review

Mode: implementation review
Decision: request changes
Topic: `pi-swe/canonical-planning`
Spec revision: 2
Plan revision: 6
Contract: `04.03`
Contract path: `.model-artifacts/plans/pi-swe/canonical-planning/revisions/r6/phases/04-workflow-rollout/04.03-atomic-completion-transition.md`
Reviewed state: frozen uncommitted shared diff after focused suite reached 13/13.

## Exact context

- Manifest: `.model-artifacts/specs/pi-swe/canonical-planning/manifest.json`
- Contract index: `.model-artifacts/plans/pi-swe/canonical-planning/revisions/r6/contracts.json`
- TDD evidence: `.model-artifacts/reports/pi-swe/canonical-planning/2026-08-31_2251-04-03-tdd-cycle.md`
- Verification: `.model-artifacts/reports/pi-swe/canonical-planning/2026-08-31_2253-04-03-verification.md`
- Plan approval: `.model-artifacts/reports/pi-swe/canonical-planning/2026-08-31_2214-plan-r6-review.md`

Canonical state is current: exact r6 approval/hash is valid, 04.03 is `in_progress` and active, 04.02 is complete, and 04.04 remains dependency-blocked.

## Findings

### High — unrelated reports can satisfy the completion evidence gate

Affected: `extensions/pi-swe/src/completion.ts:480-485`
Acceptance: one action completes only the exact approved, verified, implementation-reviewed active contract; missing/partial evidence must reject without mutation.

`validateEvidence` verifies path confinement and digest, then accepts any line matching `Outcome|Result: pass` and any line matching `Decision: approve`. It never binds artifact metadata to the requested topic, contract ID, plan revision, or contract hash; it does not require implementation-review mode; and it does not prove an all-pass acceptance map. A plan-review artifact and a passing verification report for another contract therefore authorize completion.

Independent negative test reproduced the defect: a fixture request was changed to use `.model-artifacts/reports/demo/plan-review.md` plus `unrelated-verification.md` containing `Outcome: pass`; `completeCanonicalContract` returned `completed`. The required assertion that it must not complete failed.

Action: parse a closed machine-readable evidence envelope (or strictly validated report metadata) containing topic, plan revision, contract ID/path/hash, overall decision/result, and complete acceptance statuses. Require review mode `implementation review`, exact contract identity, decision `approve`, and verification with no `fail`, `partial`, or `gap`. Bind those identities into the durable request record and add negative tests for plan review, wrong contract/revision/hash, mixed pass/fail, partial, and gap evidence.

### High — the fixed transaction journal has no exclusive owner

Affected: `extensions/pi-swe/src/completion.ts:144-147,611-620`
Acceptance: conflicting state yields deterministic no-write behavior; the two-target update is one recoverable logical transaction.

Journal acquisition is a check-then-act `existsSync`. Initial and later `persistJournal` calls always write a shared `.next` and rename it over the fixed journal, replacing any existing owner. Two local sessions can both inspect the same pre-state, prepare distinct artifacts, overwrite each other's journal, and install stale prepared snapshots. There is no lock/CAS/reinspection after exclusive claim. This can make recovery follow one request while targets were written by another, and can allow one completion to overwrite another after both passed guards.

Action: acquire the fixed journal/lock exclusively before mutation (atomic `wx`/link or equivalent), never replace a journal owned by another request, and re-inspect/revalidate target preimage hashes after ownership is durable. Stage updates must verify request/owner identity. A competing request should return deterministic conflict/blocked recovery without touching targets. Add two-process concurrency tests for identical and different requests, including contention during preparation and each rename gap.

### Medium — directory fsync failures are silently treated as durable success

Affected: `extensions/pi-swe/src/completion.ts:760-770`
Acceptance: journal stages, target renames, backups, cleanup, and journal deletion are durably parent-fsynced; no false success.

`fsyncDirectory` catches every open/fsync error and continues. That includes real durability failures such as I/O errors, not only a documented unsupported-filesystem case. The service can advance stages or return `completed` although the required directory entry persistence failed.

Action: propagate fsync failures on supported platforms into rollback/blocked recovery. If portability requires tolerating specific unsupported error codes, handle only an explicit bounded allowlist and make the reduced durability contract visible; do not swallow arbitrary failures. Add injected parent-fsync failures before/after target renames, journal stages, cleanup, and journal deletion.

### Medium — verification evidence is stale after the final review delta

Affected: `.model-artifacts/reports/pi-swe/canonical-planning/2026-08-31_2253-04-03-verification.md`

The artifact records focused 12/12, test:swe 129/129, and full 366/366, while the frozen reviewed diff now produces 13/13, 130/130, and 367/367. Current independent runs pass, but the durable acceptance map does not describe the exact reviewed diff.

Action: after fixes, refresh TDD/verification evidence and acceptance mappings against the final frozen diff before re-review.

## Current verification

- Focused completion: pass, 13/13.
- `npm run test:swe`: pass, 130/130.
- `npm run test:primitives`: pass, 8/8.
- `npm test`: pass, 367/367.
- `npm run check:resources`: pass.
- `npm run typecheck`: pass.
- `git diff --check`: pass.
- Adversarial evidence-binding test: fail as expected, proving unrelated evidence returns `completed`.

## Decision and next action

Request changes. Do not create an approving completion record or disposition 04.03 yet. Fix the two high-severity authorization/transaction-ownership defects and directory-fsync handling, add the required negative/concurrency/failure tests, refresh exact verification evidence, then request bounded implementation re-review. Existing stage/hash/presence, rollback, idempotency, stable-path, completion-record parser, command-boundary, primitive, and non-autonomous behavior otherwise appear aligned with the contract.

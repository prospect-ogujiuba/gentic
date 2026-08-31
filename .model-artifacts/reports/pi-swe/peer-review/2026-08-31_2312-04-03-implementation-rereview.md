# 04-03-implementation-rereview

Created: 2026-08-31T23:12:14.197Z
Purpose: Bounded implementation re-review of the frozen 04.03 diff after evidence, local ownership, fsync, and verification fixes.

# Contract 04.03 implementation re-review

Mode: implementation review
Decision: request changes
Topic: `pi-swe/canonical-planning`
Plan revision: 6
Contract: `04.03`
Contract path: `.model-artifacts/plans/pi-swe/canonical-planning/revisions/r6/phases/04-workflow-rollout/04.03-atomic-completion-transition.md`
Prior review: `.model-artifacts/reports/pi-swe/peer-review/2026-08-31_2258-04-03-implementation-review.md`
Verification: `.model-artifacts/reports/pi-swe/canonical-planning/2026-08-31_2253-04-03-verification.md`
Verification hash: `sha256:1152834aa999164e316081b619f1c54e7cd677f84c552d85be73273cf901dbf0`

## Resolved findings

- Exact evidence authorization: resolved. Closed single-line verification and implementation-review envelopes bind exact topic, contract ID/path/hash, plan revision, pass/no-gaps, approve/zero-blockers, and the exact verification path/hash. The prior unrelated-report exploit now rejects.
- Directory durability: resolved. Completion-path parent open/fsync failures propagate; only best-effort close in `finally` is suppressed.
- Stale verification counts: resolved. The refreshed evidence matches the frozen 15/132/8/369 results and its digest is current.
- Basic live-owner exclusion: substantially resolved. Claim creation uses `wx`, malformed/unreadable EEXIST is busy, live PIDs do not age out, and the nested loser is rejected before touching targets.

## Findings

### High — stage mutations are not bound to the held claim owner

Affected: `extensions/pi-swe/src/completion.ts` claim/journal lifecycle (`CompletionClaim`, `CompletionJournal`, `createJournalExclusive`, `persistJournal`, target installation, recovery, cleanup).
Acceptance: one exclusive local transaction owns prepare/install/recovery/cleanup; conflicting work must not touch targets.

The durable claim has a random token, but the journal does not store it and stage updates verify only topic/request/contract. The implementation never proves immediately before journal creation, each target rename, stage replacement, rollback restore, or cleanup that the caller still owns the current claim token. If the claim is removed/replaced, the old actor can continue mutating while a new owner runs; same-request actors are especially indistinguishable to journal checks.

Stale-claim reclamation also has an ABA race: two contenders can both read the same dead claim; one removes and creates a new live claim, then the other executes its already-decided `rmSync` and deletes that new claim before acquiring another. Initial journal `wx` limits one write, but the winner can lose its lock and continue because later mutations do not verify its token; a subsequent owner may recover the journal concurrently.

Action: bind an ownership token to the transaction lifecycle (either add `ownerToken` to the closed journal or pass/verify the held claim token against the live claim before every journal/target/restore/cleanup mutation). Make stale takeover atomic/ABA-safe; alternatively never auto-delete a stale claim during completion and require an explicit bounded recovery takeover. Losing ownership must stop before touching targets and return conflict/blocked recovery. Ensure release remains compare-by-token.

### Medium — concurrency verification is not truly inter-process and misses claim visibility/takeover races

Affected: `test/pi-swe-completion.test.ts`, exclusive-owner test.

The current test nests a second synchronous call only after the winner's claim file is fully written. It does not exercise another process observing an incomplete claim, an aged-but-live owner, simultaneous stale-claim reclaimers, claim replacement between stages, or one owner dying with a journal.

Action: add child-process/barrier tests proving exactly one owner and a no-write loser for identical/different requests; malformed/incomplete claim remains busy; live PID is never evicted; concurrent stale takeover cannot delete a newly acquired token; owner-token replacement blocks the old actor before its next mutation; recovery obtains explicit ownership after owner death.

## Verification

- Focused completion: pass, 15/15.
- `npm run test:swe`: pass, 132/132.
- `npm run test:primitives`: pass, 8/8.
- `npm test`: pass, 369/369.
- `npm run check:resources`: pass.
- `npm run typecheck`: pass.
- `git diff --check`: pass.
- Verification artifact digest: exact match.

## Decision

Request changes. Do not emit a completion-eligible approval envelope or disposition 04.03. Preserve the resolved evidence/fsync behavior, close the ownership-token and stale-takeover races, add real inter-process tests, refresh verification, then request one bounded re-review.

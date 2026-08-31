# Specialist review: atomic completion transition

Topic: `pi-swe/canonical-planning`
Spec revision: 2
Plan revision: 2
Plan: `.model-artifacts/plans/pi-swe/canonical-planning/2026-08-31_2110-plan-index-r2.md`
Decision: complete — incorporated into contracts 04.03 and 04.04

## TDD

Required integration Red cases are incorporated in 04.03: stale expected hash, missing/partial verification, non-approve review, wrong active contract, injected second-write failure and recovery, successful completion, next-ready selection, idempotent repeat, stable filename assertion, and canonical-versus-legacy primitive guidance. Final end-to-end coverage is deferred to 04.04 by dependency.

## Operations

A two-document completion cannot be physically atomic across separate renames, so it must be a recoverable logical transaction rather than merely sequential. The contract requires target-adjacent temporary files, fsync, a durable staged journal with pre/new hashes, deterministic rename ordering, parent-directory fsync, reader detection, roll-forward/rollback recovery, post-write inspection, and a no-guess recovery handoff. Status output substitutes for filename scanning with contract disposition, phase progress, next-ready contract, and blockers.

## Migration

Historical `[COMPLETE]` names remain valid legacy inputs and are not bulk-renamed. New active canonical revisions retain stable paths. The primitive must distinguish canonical machine state from legacy marker guidance, and 04.04 must document and sample both modes without mixing them silently.

## Compatibility

Existing skills, `/swe status`, and guidance-only orchestration remain. A single explicit guarded completion action may be added; it must not start autonomous work, commit, push, or finalize the initiative. Todo and peer extensions remain optional.

## DSA and performance

No new graph representation is required. Reuse the existing deterministic lowest-ready ordering and bounded contract index. The two-file transaction is constant-document-count local I/O; correctness and recovery dominate optimization.

## Security

No new authentication or privilege boundary. Path confinement, symlink/escape rejection, exact expected hashes, and no-write failure behavior are required correctness controls.

## Open findings

None blocking plan r2 review.
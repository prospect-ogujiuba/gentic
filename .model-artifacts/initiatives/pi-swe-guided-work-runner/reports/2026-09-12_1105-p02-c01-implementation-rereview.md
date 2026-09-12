# p02-c01-implementation-rereview

Created: 2026-09-12T11:05:30.577Z
Purpose: Durable repeat implementation-review decision for P02-C01 against verification rerun 2.

# Implementation rereview: P02-C01 command and checkpoint tool surface

Timestamp: 2026-09-12 07:05 EDT
Mode: implementation-review
Decision: request changes

## Exact context

- Topic: `pi-swe-guided-work-runner`.
- Active spec: revision 1, `.model-artifacts/initiatives/pi-swe-guided-work-runner/specs/2026-09-11_1922-initiative-spec-r1.md`, `sha256:6f6322a43d11d32bd3b1d52d14633f728247b8b7dc042cde07039daf1bd5c0b0`.
- Active approved plan: revision 2, `.model-artifacts/initiatives/pi-swe-guided-work-runner/plans/2026-09-11_1924-plan-index-r2.md`, `sha256:9c56a764f9d960ce9aab78269afb6dd0b3c26aec8a6397996c236b6c4f890aab`.
- Contract: `P02-C01`, `.model-artifacts/initiatives/pi-swe-guided-work-runner/plans/revisions/r2/phases/02-controlled-execution/02.01-command-and-checkpoint.md`, `sha256:4198d72e6940d596211fab556b2eb5bb2390245be025e391aaedbad6f9a37326`.
- Dependency `P01-C02` is complete; active contract is `P02-C01`; no authority/hash/dependency conflict was found.
- Incorporated DSA, TDD, and security/operations/compatibility findings remain current at their plan-linked paths.
- Prior review: `.model-artifacts/initiatives/pi-swe-guided-work-runner/reports/2026-09-12_0648-p02-c01-implementation-review.md`.
- Current verification: `.model-artifacts/initiatives/pi-swe-guided-work-runner/reports/2026-09-12_1100-p02-c01-verification-r2.md`, `sha256:683287d70f1104e0a26c1ed10f92248a3df5151a6419c0552c7eb8a025b83d31`.

## Resolved prior findings

- Persisted blocked state for contradictory checkpoints: resolved and tested.
- Explicit-topic status/pause/stop with missing canonical metadata: resolved and tested.
- Deterministic lowest-ready selection without `activeContract`: resolved and tested with multiple ready contracts.
- Filesystem validation races now return bounded rejection.

## Finding

### High — valid non-`completed` checkpoint outcomes are reported as rejected and completion intent is discarded

- Affected path: `extensions/pi-swe/src/pi/tools.ts:137-145`; AC-04 structured checkpoint outcome handling and the P02-C01 model-callable checkpoint surface.
- The reducer has valid results beyond `none/checkpoint-accepted`: `contract-ready` from `implementation-review` returns `complete-contract`; `return-to-plan` returns `pause`; declared blocked outcomes and exhausted valid retries return `blocked-handoff`. The tool defines `accepted` only as `none/checkpoint-accepted`, persists the other valid reductions, then reports every one as rejected. For `contract-ready`, persisted state is still `running` with no pending dispatch and the `complete-contract` action is neither returned in details nor retained in runner state, so the valid completion checkpoint intent is lost before P02-C02 can consume it.
- Deterministic reproduction: a valid `implementation-review`/`contract-ready` reducer call returns `{kind:"complete-contract"}` with runner status `running`; the tool predicate evaluates false. A valid `blocked`/`unsafe-operation` checkpoint returns a persisted `blocked-handoff`, but the tool still labels it rejected.
- Action: classify protocol-valid checkpoint outcomes separately from invalid checkpoint reductions. Persist each valid reduction, return `status: accepted`, and surface its typed reducer action (or an injected controller seam) so later settled/completion wiring can consume `complete-contract`, `pause`, and `blocked-handoff` without performing P02-C01’s non-goal actions. Preserve exact-duplicate idempotence and reject/persist-block truly invalid transitions or identities. Add tool-level cases for `completed`, permitted `retry`, exhausted retry, `blocked`, `return-to-plan`, valid `contract-ready`, and invalid `contract-ready` stage.
- Violated evidence claim: the current verification map marks AC-04 and the full structured outcome surface pass, but focused tool tests exercise only `outcome: completed` as an accepted call. Verification therefore has a gap and cannot support completion.

## Verification implications

Current verification rerun 2 is insufficient for AC-04 outcome handling. After the fix, rerun focused tool tests, nearby runner/persistence tests, `npm run test:swe`, `npm run typecheck`, `npm run check:pi-api`, resource checks, and `git diff --check`; issue a new verification artifact with a complete per-outcome map.

## Open blockers and residual risk

- Blocking findings: 1 high.
- The three findings from the prior review are closed.
- No material plan revision is required; this is an in-contract checkpoint-tool correctness fix.

## Next action

Implement valid-outcome classification/action surfacing without dispatch or automatic completion, expand focused tool tests, rerun verification, and repeat implementation review. This review emits no approval evidence envelope.

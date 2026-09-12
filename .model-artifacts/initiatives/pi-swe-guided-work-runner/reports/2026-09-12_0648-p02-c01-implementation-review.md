# p02-c01-implementation-review

Created: 2026-09-12T06:48:09.310Z
Purpose: Durable implementation-review decision for canonical contract P02-C01.

# Implementation review: P02-C01 command and checkpoint tool surface

Timestamp: 2026-09-12 02:47 EDT
Mode: implementation-review
Decision: request changes

## Exact context

- Topic: `pi-swe-guided-work-runner`
- Active spec: revision 1, `.model-artifacts/initiatives/pi-swe-guided-work-runner/specs/2026-09-11_1922-initiative-spec-r1.md`, `sha256:6f6322a43d11d32bd3b1d52d14633f728247b8b7dc042cde07039daf1bd5c0b0`
- Active approved plan: revision 2, `.model-artifacts/initiatives/pi-swe-guided-work-runner/plans/2026-09-11_1924-plan-index-r2.md`, `sha256:9c56a764f9d960ce9aab78269afb6dd0b3c26aec8a6397996c236b6c4f890aab`
- Contract: `P02-C01`, `.model-artifacts/initiatives/pi-swe-guided-work-runner/plans/revisions/r2/phases/02-controlled-execution/02.01-command-and-checkpoint.md`, `sha256:4198d72e6940d596211fab556b2eb5bb2390245be025e391aaedbad6f9a37326`
- Dependency: `P01-C02` complete; active contract remains `P02-C01` pending.
- Incorporated findings: DSA `.model-artifacts/initiatives/pi-swe-guided-work-runner/findings/2026-09-11_1923-dsa-decision.md`; TDD `.model-artifacts/initiatives/pi-swe-guided-work-runner/findings/2026-09-11_1923-tdd-plan.md`; security/operations/compatibility `.model-artifacts/initiatives/pi-swe-guided-work-runner/findings/2026-09-11_1923-security-operations-compatibility.md`.
- Implementation evidence: `.model-artifacts/initiatives/pi-swe-guided-work-runner/reports/2026-09-11_2357-tdd-cycle.md`.
- Verification: `.model-artifacts/initiatives/pi-swe-guided-work-runner/reports/2026-09-12_0643-p02-c01-verification.md`, current hash `sha256:5b10c228aca5d8d2d18b54321e6338d071fe26381590ebb8741101f4478b8b24`.

## Findings

### High — rejected contradictory/stale dispatch checkpoints do not stop persisted continuation

- Affected area: `extensions/pi-swe/src/pi/tools.ts:137-141`; AC-04, invalid-checkpoint no-continuation requirement, and the incorporated operations rule for contradictory events.
- The pure reducer returns a persisted blocked state for invalid token/contradictory checkpoint decisions, but the tool returns `rejected` for every non-`checkpoint-accepted` action before persisting `reduced.state`. After a valid checkpoint has been accepted, a contradictory duplicate can therefore be rejected while leaving the runner eligible for the P02-C02 settled controller to continue.
- Action: distinguish idempotent duplicate (`none/duplicate-checkpoint`) from blocking reducer decisions. Preserve no mutation for an exact duplicate, but atomically persist terminal/blocked reducer state for invalid token, contradictory result, or other protocol violations that must prevent continuation. Add assertions on persisted `status`/`terminalReason` and no continuation eligibility, not only accepted sequence.

### High — operator status/pause/stop are unavailable when canonical authority cannot resolve

- Affected area: `extensions/pi-swe/src/pi/commands.ts:188-193`; AC-01 and operator portions of AC-09.
- Every work action returns before reading runner state unless `resolveForCommand` yields `sourceMode: canonical`. With an explicit valid topic, a missing/corrupt/mixed/stale canonical manifest can therefore prevent status, pause, and stop even though a persisted runner exists. This conflicts with the specification that the operator can always stop the loop and with recovery diagnostics requiring owner/run visibility.
- Action: for explicit topic status/pause/stop, validate the topic through the persistence boundary and inspect/control persisted runner state without granting execution authority from broken canonical metadata. Continue requiring fresh canonical resolution for start/resume. Add corrupt/missing canonical-authority tests proving status visibility and idempotent pause/stop with no dispatch.

### Medium — start cannot select a deterministic ready contract when `manifest.activeContract` is absent

- Affected area: `extensions/pi-swe/src/pi/commands.ts:291-300`; AC-01/AC-02 and the approved canonical recommendation boundary.
- `recommendGateAwareOrchestration` supports selecting the lowest ready contract when no active contract is recorded, but `canonicalRunnerIdentity` requires `manifest.activeContract` and rejects start. The approved plan says the command/tool boundary uses fresh canonical recommendation, and a newly approved plan may have ready work before an active contract is established.
- Action: derive the authorized identity from the recommendation-selected contract, then bind its exact contract-index path/hash and active plan revision. Add a canonical fixture with no `activeContract` and one/multiple ready contracts proving deterministic selection and exact identity.

## Verification implications

The verification artifact is current by hash but its `pass`/`gaps: none` conclusion is insufficient for the findings above. After fixes, rerun focused command/checkpoint tests, nearby runner/persistence tests, `npm run test:swe`, `npm run typecheck`, `npm run check:pi-api`, and `git diff --check`; issue a new verification artifact and review that exact hash.

## Open blockers and residual risk

- Blocking findings: 3 (2 high, 1 medium).
- Residual filesystem TOCTOU risk exists in synchronous evidence validation (`existsSync` followed by `lstatSync`/`statSync`/`readFileSync`); convert unexpected filesystem races into bounded tool rejection while touching this path.
- No material plan revision is required: all requested changes are in-contract correctness fixes.

## Next action

Implement the three in-contract fixes with focused regression tests, rerun verification, then repeat implementation review for exact contract `P02-C01`. This review emits no approval evidence envelope.

# 04-02-implementation-review

Created: 2026-08-31T20:09:59.772Z
Purpose: Record the fresh implementation-review decision for active contract 04.02 after canonical repair.

# Implementation review: subphase 04.02

Mode: implementation review
Decision: request changes
Topic: `pi-swe/canonical-planning`
Spec revision: 2
Plan revision: 1
Contract: `04.02`

## Exact context

- Manifest: `.model-artifacts/specs/pi-swe/canonical-planning/manifest.json`
- Spec: `.model-artifacts/specs/pi-swe/canonical-planning/2026-08-30_0331-initiative-spec-r2.md`
- Plan: `.model-artifacts/plans/pi-swe/canonical-planning/2026-08-30_0333-plan-index-r1.md`
- Contract index: `.model-artifacts/plans/pi-swe/canonical-planning/revisions/r1/contracts.json`
- Contract: `.model-artifacts/plans/pi-swe/canonical-planning/revisions/r1/phases/04-workflow-rollout/04.02-execution-lifecycle-skills.md`
- Specialist evidence: `.model-artifacts/findings/pi-swe/canonical-planning/2026-08-31_1957-specialist-incorporation.md`
- Verification: `.model-artifacts/reports/pi-swe/canonical-planning/2026-08-31_2005-04-02-verification.md`
- Prior review: `.model-artifacts/reports/pi-swe/implementation-review/2026-08-31_1919-04-02-implementation-review.md`

Canonical validation passes: zero diagnostics, exact approval/hash valid, `04.02` is active and ready, and predecessor `04.01` is complete. The expected 04.03/finalization blockers do not block review of 04.02.

## Findings

### High — orchestration artifact contract assigns slice contracts to the wrong artifact kind

Affected path: `extensions/pi-swe/skills/swe-orchestrate/SKILL.md:28-29`
Violated criterion: artifact kinds/paths are consistent across every skill.

The orchestrator says `.model-artifacts/specs/<topic>/...` stores “work orders and slice contracts” and describes `.model-artifacts/plans/<topic>/...` only as orchestration plans. The approved canonical workflow stores immutable specs under `specs` and phase/subphase contracts under `<activePlan.contractRoot>/phases` in `plans`. This contradiction can route a standalone orchestrator to the wrong write/read location.

Action: change the mapping to specs = manifest and immutable initiative spec revisions; plans = plan indexes, `contracts.json`, and phase/subphase contracts. Preserve logs/findings/reports boundaries.

### Medium — scope-drift template still calls an assigned todo the original contract

Affected path: `extensions/pi-swe/skills/swe-implement/SKILL.md:44`
Violated criterion: no execution skill treats a todo or filename as sufficient approval.

The execution gate correctly rejects todo approval, but the later template says `Original contract: assigned file/todo`. That reintroduces ambiguous authority in the same skill.

Action: require exact canonical contract ID/path/revision/hash; list todo only as an optional link.

### Medium — resource assertion can hide per-skill contract omissions

Affected path: `test/pi-swe.test.ts:365-399`
Violated criterion: artifact kinds/paths are consistent across every skill; the TDD boundary requires resource assertions for the execution contract.

Most required phrases are asserted only against one concatenated `executionResources` string. One compliant skill can satisfy a phrase while another applicable skill omits or contradicts it; this allowed the orchestrator path defect to pass.

Action: add targeted assertions for the orchestrator artifact map and implement contract-authority template, while retaining the combined legacy-namespace omission check.

## Verification implications

Current evidence is fresh and all commands pass (`test:swe` 117/117, resource check, typecheck), but it is insufficient for the two uncovered content defects. After edits, rerun the focused execution-lifecycle resource test, `npm run test:swe`, `npm run check:resources`, and `npm run typecheck`; update the acceptance-to-evidence map.

## Open blockers, residual risks, and next action

- Blocking for implementation approval: the high artifact-routing contradiction and two medium contract/assertion gaps.
- No return-to-plan condition: all fixes are within exact contract 04.02 scope and do not change architecture or approved outcomes.
- Residual risk after repair: prose-only contracts still depend on resource assertions rather than runtime enforcement, which is accepted by this slice's resource-contract boundary.

Next action: make the three narrow edits above, refresh verification evidence, and request one bounded implementation re-review. Contract 04.02 is not yet eligible for `complete` disposition.

---
name: swe-review
description: Review plans or implementations with an explicit mode, actionable findings, verification fit, and residual-risk decisions.
---

# SWE Review

Select exactly one mode before reviewing. Plan approval and post-implementation approval are distinct decisions and cannot substitute for each other.

## Plan-review mode

Use before implementation to assess the exact canonical spec and plan revisions.

1. Confirm one topic, revision links, canonical paths, contract metadata, and unresolved blockers.
2. Check architecture, boundaries, compatibility, and completeness against the initiative outcomes and non-goals.
3. Check phase/subphase granularity, dependencies and dependency graph correctness, entry inputs, ordering, and first-ready status.
4. Check the specialist applicability matrix and consequential DSA, TDD, security, migration, performance, accessibility/UX, operations, and compatibility findings.
5. Confirm accepted specialist findings are incorporated into the reviewed plan revision, not merely linked.
6. Check migration and rollback, outcome traceability, acceptance criteria, verification matrix, and evidence feasibility.
7. Test developer executability: each contract must be implementable without reconstructing intent from chat.
8. Decide `approve`, `request changes`, or `return to spec`. Approve only the exact reviewed revision with no unresolved blocking finding; `return to spec` when outcomes or constraints are incomplete or contradictory.

Plan review never implements and never claims plan-time Red evidence. Changes require a new revision and re-review of affected decisions.

## Implementation-review mode

Use after implementation and verification for one exact contract/revision from the active approved plan.

1. Read `.model-artifacts/specs/<topic>/manifest.json`, the active spec and active approved plan, `<activePlan.contractRoot>/contracts.json`, the exact contract, incorporated findings, implementation notes/diff, and verification artifact. Validate revision, approval, `contentHash`, dependency, blocker, and active-contract state before judging the diff.
2. Compare the diff and evidence only with that exact contract/revision, its scope/non-goals, acceptance criteria, and planned verification.
3. Check correctness, edge cases, state transitions, compatibility, and applicable error, validation, security, data, performance, migration, rollback, operations, and UX risks.
4. Reject unrelated churn; do not add adjacent features or silently edit the approved contract.
5. Confirm the acceptance-to-evidence map is current and labels every criterion/check `pass`, `fail`, `partial`, or `gap`.
6. Decide `approve`, `request changes`, or `return to plan`. Approve only when the in-scope diff satisfies the exact contract with current evidence. Request changes for in-contract defects. Return to plan for a stale revision, scope/material-design drift, missing verifier, incompatible dependency/blocker state, or conflicting changes.
7. Use bounded review/fix retries; repeated unresolved findings stop with a durable handoff.

Implementation review works standalone. Todo may record the decision but neither todo nor a filename is approval.

## Review artifact

A substantial review, multi-file/phase review, or any non-approval decision requires a durable artifact. Plan reviews and implementation reviews both use:

`.model-artifacts/reports/<topic>/YYYY-MM-DD_HHMM-<plan-or-implementation>-review.md`

Reserve `.model-artifacts/findings/<topic>/` for specialist findings; do not place plan reviews there.

Include:

- Mode and decision.
- Exact context links: topic, spec/plan revision, contract when applicable, specialist findings, implementation, verification, and prior review.
- Findings: severity, action, affected path/area, and the violated outcome or acceptance criterion.
- Verification implications: sufficient, missing, stale, or required reruns.
- Open blockers, residual risks, next action, and the revision or contract eligible for approval.

Skip the artifact only for a tiny implementation review with no residual risk or durable decision. When todo is available, record the artifact; review must still work without it.

## Output

Return only decision, artifact path when created, blockers/highest-severity findings, and next edit/review action.

## Success criteria

- Plan-review mode proves architecture, completeness, specialist incorporation, dependency safety, verification fit, and developer executability.
- Implementation-review mode proves an implementation against its approved contract and evidence.
- Findings are severity-labelled, actionable, and path/criterion-linked.
- Approval identifies one exact revision or contract and does not expand scope.

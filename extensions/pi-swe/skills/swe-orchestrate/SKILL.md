---
name: swe-orchestrate
description: Sequence existing pi-swe lifecycle skills from work orders, todos when available, and durable model artifacts without adding coupling or hidden autonomous execution.
---

# SWE Orchestrate

Use this when a SWE flow needs a next-stage recommendation, resume decision, or deterministic handoff across existing `pi-swe` stages.

## Workflow

1. **Inspect work order and canonical state before chat** — for one exact topic, read `.model-artifacts/initiatives/<topic>/specs/manifest.json`, its active spec and active approved plan, `<activePlan.contractRoot>/contracts.json`, the exact active/ready contract when applicable, linked findings/evidence/reviews, and only then current todo/repository state.
2. **Validate identity and readiness** — check every revision, path, `contentHash`, approval, dependency, blocker, contract readiness fact, planned verifier, and active-contract pointer. A todo or filename is not approval.
3. **Choose the next lifecycle stage** — classify the path as feature, bug, DSA-sensitive, resume, finalize-gated, or blocked.
4. **Follow the matching existing skill** — use `swe-plan`, `swe-diagnose`, `swe-tdd`, `swe-dsa`, `swe-implement`, `swe-verify`, `swe-review`, or `swe-finalize`; do not duplicate detailed instructions or execute hidden autonomous work.
5. **Enforce execution gates** — route only one dependency-satisfied exact contract from the active approved plan. Required specialist findings must be incorporated, not merely linked.
6. **Require mapped evidence and review** — route to `swe-verify` for acceptance-to-evidence mapping, then implementation review before contract disposition or finalization.
7. **Reconcile before finalization** — use `swe-finalize` only when contract dispositions, approved deferrals, evidence, reviews, blockers, and residual risks can be reconciled.
8. **Reconcile stage-boundary todo state** — when todo is available, treat it as the LLM's bounded work ledger, not as a second copy of the canonical plan. Use one active todo for the exact current planning outcome or implementation contract. Before final chat or routing onward, attach durable evidence and finish completed work; never leave it `ready`, `claimed`, or `in_progress`. Do not create nested stage scaffolds or pre-populate future contracts. Reconcile only the bounded current-work todo and proven duplicate/scaffold descendants created for this workflow. Among those workflow-owned entries, leave no stale completed-work state and at most one nonterminal handoff: the exact active item, or a truthfully external-blocked item with its reason. Preserve unrelated legitimate ledger entries unchanged; never finish, cancel, supersede, or block them merely to make the docket look clean. Canonical `contracts.json` remains the queue for later work.
9. **Emit a deterministic exception handoff** — stale revision, dependency, blocker, missing verifier, scope drift, or conflicting changes stop work. Report observed/required state, exact paths, and the next skill/human decision; return to plan where the approved contract must change.
10. **Bound retries** — after one unchanged readiness failure, stop and hand off rather than repeatedly rereading or mutating state.

This guidance remains standalone without todo or peer extensions.

## Artifact contract

Prefer durable model artifacts as the cross-session contract:

- `.model-artifacts/initiatives/<topic>/specs/...` for the manifest and immutable initiative spec revisions.
- `.model-artifacts/initiatives/<topic>/plans/...` for plan indexes, `contracts.json`, and phase and subphase contracts.
- `.model-artifacts/initiatives/<topic>/logs/...` only for optional state/resume trails, never approval or verification evidence.
- `.model-artifacts/initiatives/<topic>/findings/...` for diagnosis, DSA, and implementation-drift findings.
- `.model-artifacts/initiatives/<topic>/reports/...` for plan/implementation reviews, verification, final handoff, and exception reports.

Optional tools such as todo or git evidence may enrich context when visible to the agent, but orchestration must still work without them and must not depend on peer extension internals.

## Report format

- Current artifact readiness.
- Next recommended lifecycle step.
- Required read paths.
- Intended write path and artifact kind, or `none`.
- Gate status for verification, review, finalize, and todo reconciliation when available.
- Exception handoff, if blocked.

Report exact reads and the one intended write destination concisely; never dump artifact contents into chat.

---
name: swe-plan
description: Plan SWE work through canonical specification, specialist review, revision, and approval. Use before non-trivial code changes or when scope is unclear.
---

# SWE Plan

Produce execution-ready planning artifacts. Never implement production changes while using this skill.

## Work profile

Classify the request before writing:

- **Trivial**: one obvious, low-risk, single-contract step with no dependency, architecture, migration, or consequential specialist decision. Use a compact inline plan, but retain applicability, acceptance, verification, and explicit approval/readiness gates; do not create todo-root canonical writes.
- **Non-trivial**: use the canonical workflow below. Planning must work without a todo provider. Todo may only record or link approved contracts after approval.

## Canonical identity and paths

1. Choose one exact, kebab-case `<topic>` (nested segments are allowed) and reuse it everywhere; stop for clarification if more than one topic is plausible.
2. Use `.model-artifacts/specs/<topic>/manifest.json` as the mutable machine-readable initiative index and `.model-artifacts/specs/<topic>/YYYY-MM-DD_HHMM-initiative-spec-rN.md` for immutable specification revisions.
3. Use `.model-artifacts/plans/<topic>/YYYY-MM-DD_HHMM-plan-index-rN.md` for immutable plan-index revisions.
4. Set `activePlan.contractRoot` to `.model-artifacts/plans/<topic>/revisions/rN`, put phase and subphase contracts below its `phases/` directory, and maintain `<activePlan.contractRoot>/contracts.json` as the machine-readable contract index.
5. Put specialist findings below `.model-artifacts/findings/<topic>/` and plan reviews below `.model-artifacts/reports/<topic>/`; each artifact links the exact spec and plan revision it assessed.
6. Each new revision links its predecessor and all active artifacts and indexes link the current canonical spec, plan index, findings, review, and approval decision.

## Workflow: Specify → Classify → Draft → Review → Revise → Approve

1. **Specify** — define outcome, observable behavior, users, constraints, non-goals, compatibility, risks, migration/rollback needs, acceptance criteria, and open blockers in one canonical initiative spec. Create/update `manifest.json` with `initiativeState`, `activeSpec`, and its current `contentHash`.
2. **Classify** — create the manifest specialist applicability matrix for diagnosis, DSA, TDD, security, migration, performance, accessibility/UX, operations, and compatibility. Mark each `required`, `not-required` with rationale, or `blocked`.
3. **Draft phases and subphases** — create the plan index, dependency graph, narrow contracts, and `contracts.json`. Use phase files for grouping and subphase files as the default implementation contracts; set the manifest `activePlan` pointer and planning state.
4. **Specialist review** — run required specialist skills against the exact active revisions. Change each finished `required` specialist to `complete` with its finding path. Accepted specialist findings must be incorporated into a new spec or plan revision before approval; links alone are insufficient.
5. **Plan review** — invoke `swe-review` in plan-review mode, set the reviewing state, and write the plan review under `.model-artifacts/reports/<topic>/`. Do not use implementation-review findings as plan approval.
6. **Revise** — resolve findings in immutable revisions; update content hashes, active pointers, contract index, revision links, traceability, dependencies, applicability, verification, and blockers; then repeat specialist or plan review where affected.
7. **Approve** — require an explicit `approve`, `request changes`, or `return to spec` decision tied to exact revision paths. For approval, record the exact active plan revision/path/hash, review path, timestamp, and zero blocking findings in the manifest and set the approved state.
8. **Mark first contract ready** — only after approval, compute and report the first dependency- and gate-satisfied contract from `contracts.json`. Do not set `activeContract` until orchestration starts execution. Do not mirror the canonical plan, planning stages, or future contract tree into todo or `.model-artifacts/todo/<topic>/phases/`. Create/link only the first ready contract when execution will start now or an explicit todo handoff was requested.
9. **Reconcile the LLM work ledger** — when todo is available, use one bounded planning todo for the planning outcome rather than nested todos for Specify/Classify/Draft/Review/Revise/Approve. Attach the exact plan/review artifacts as evidence and finish the active planning todo before the final response when approval/readiness is the requested outcome. Do not leave completed planning work `ready`, `claimed`, or `in_progress`; do not pre-create speculative implementation todos. Reconcile only the bounded current-work todo and proven duplicate/scaffold descendants created for this planning flow; preserve unrelated legitimate ledger entries unchanged. If planning cannot finish, leave at most one truthful active handoff among those workflow-owned entries, or mark it externally blocked only when it is waiting on a user, external system, or outside dependency.

## Required canonical documents

The mutable schema-v1 `manifest.json` records `schemaVersion`, `initiativeId`, exact `topic`, `initiativeState`, `activeSpec` (`revision`, `path`, `contentHash`), optional `activePlan` (`revision`, `path`, `contentHash`, `contractRoot`), all specialist statuses/rationales/finding paths, `updatedAt`, and—when approved—the exact approval record. Add the optional `activeContract` pointer only when execution starts.

The initiative spec records exact topic, problem/outcomes, constraints/non-goals, acceptance criteria, compatibility, migration/rollback, risks, and open blockers.

The plan index records:

- metadata: contract ID, status, created date, topic, active spec revision/path, plan revision, predecessor, and approval/review links;
- ordered phases and subphases with canonical paths;
- dependency graph and first-ready contract;
- specialist applicability matrix and finding paths;
- outcome-to-contract traceability table;
- acceptance-to-evidence verification matrix;
- revision history, approval status, and open blockers.

The schema-v1 `contracts.json` records every contract's kind/ID, dependencies, plan revision, canonical path, status, and `contentHash`; contract readiness facts for entry inputs, capabilities, applicability, acceptance, verification, and approved deferrals; and consequential specialist IDs. Keep it synchronized with contract files before evaluating readiness.

Each implementation contract records Goal, observable behavior, Scope and Non-goals, Dependencies and entry inputs, Expected files/outputs, specialist decisions incorporated, Acceptance criteria, Verification, rollback/migration constraints where applicable, status, and links to the exact spec and plan revisions. A developer must be able to execute it without reconstructing intent from chat.

## TDD planning boundary

At plan time, `swe-tdd` chooses observable behaviors, test levels, characterization needs, Red ordering, and verification scope. Plan-time TDD does not claim Red evidence; Red evidence exists only after the test has actually run and failed during implementation.

## Output

Return only:

- key canonical artifact paths;
- review/approval decision;
- open blockers;
- next edit/review order, or the first ready contract after approval.

## Success criteria

- One exact topic has linked, immutable spec and plan revisions.
- Phases and subphases are dependency-safe, traceable, verifiable, and developer-executable.
- Required specialist findings are incorporated before plan approval.
- Planning stops at an explicit readiness result and does not implement.
- When todo is available, completed planning work is evidence-backed and finished before final chat; the docket contains no nested planning scaffold or speculative future-contract entries.
- The workflow remains standalone and introduces no legacy command namespace.

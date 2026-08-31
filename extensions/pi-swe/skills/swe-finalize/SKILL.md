---
name: swe-finalize
description: Finalize SWE work with concise explanation, reflection, verification evidence, and completion guidance.
---

# SWE Finalize

Use this only when an initiative or explicitly bounded contract handoff is ready to reconcile, record, commit, or close.

## Reconciliation gate

Read `.model-artifacts/specs/<topic>/manifest.json`, the active spec and active approved plan, `<activePlan.contractRoot>/contracts.json`, every in-scope exact contract/revision, incorporated findings, implementation notes, verification evidence, and implementation-review decisions. Validate current `contentHash` links and approval. Todo state or filenames may supplement this chain but cannot replace it.

Reconcile contract dispositions as `complete`, `blocked`, or `approved-deferred`; acceptance-to-evidence outcomes; approved deferrals; review decisions; open blockers; residual risks; migration/rollback; and the next handoff. Do not finalize while required evidence is stale/missing, a review requests changes, a contract is undisposed, or a deferral lacks plan approval. A stale revision, missing verifier, scope drift, or conflicting change returns to plan with exact affected paths.

## Workflow

1. State the initiative/topic, active approved plan revision, reconciliation boundary, and exact contract dispositions.
2. Explain what changed, why, and the key paths touched.
3. Summarize criterion-mapped verification outcomes and link durable evidence.
4. Link implementation-review artifacts and approve/request-changes/return-to-plan decisions.
5. Record approved deferrals, learned constraints, residual risks, rollback/migration status, and anything explicitly out of scope.
6. Provide the next action: todo evidence, commit/PR, docs/release step, blocked handoff, or `/skill:swe-plan` revision.
7. Update terminal canonical state only after reconciliation succeeds; never claim unverified completion.
8. For initiative, multi-contract, or residual-risk handoffs, write a durable handoff artifact.

Finalization is standalone and uses bounded retries: unresolved reconciliation conflicts stop with evidence rather than looping.

## Handoff artifact

Skip the artifact for a single small change where the final chat response is sufficient and no evidence chain or residual risk needs to survive.

When required, write the handoff artifact to:

`.model-artifacts/reports/<topic>/YYYY-MM-DD_HHMM-handoff.md`

Include these sections:

- Summary: what changed and why.
- Changed paths: key code, test, documentation, plan, implementation, verification, and review artifact paths.
- Verification evidence: commands, outcomes, manual checks, and verification artifact links where available.
- Review links: review artifact paths and decision summaries where available.
- Residual risks, deferred work, or scope boundaries.
- Next action: commit/PR/release step, return-to-plan item, or verification handoff.

After writing an artifact, keep chat output concise and path-oriented: handoff path, verification status, residual risks, and next action.
When a todo is active, record the handoff artifact in the todo ledger.

## Success criteria

- The handoff is short, factual, and evidence-backed.
- Larger handoffs are durable when an artifact is warranted.
- Verification and review artifacts are referenced when available.
- Remaining work is explicit rather than hidden.

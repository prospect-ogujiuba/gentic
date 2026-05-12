---
name: swe-finalize
description: Finalize SWE work with concise explanation, reflection, verification evidence, and completion guidance.
---

# SWE Finalize

Use this when work is ready to hand off, record, commit, or close.

## Workflow

1. Gather available artifact paths for the plan, implementation notes, verification evidence, and review decision.
2. Explain what changed, why, and the key paths touched.
3. Summarize verification evidence and any manual checks, linking verification artifacts when available.
4. Link review artifacts and decisions when available, especially approve/request-changes/return-to-plan outcomes.
5. Reflect on what was learned and what remains risky or deferred.
6. Provide completion guidance: todo evidence, commit/PR note, docs, release step, or return-to-plan action.
7. State boundaries clearly; do not claim unverified completion.
8. For larger-than-single-change handoffs, multi-file/phase work, or any handoff with residual risk, write a durable handoff artifact.

## Handoff artifact

Skip the artifact for a single small change where the final chat response is sufficient and no evidence chain or residual risk needs to survive.

When required, write the handoff artifact to:

`.model-artifacts/finalize/<topic>/YYYY-MM-DD_HHMM-handoff.md`

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

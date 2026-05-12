---
name: swe-review
description: Review SWE work for correctness, hardening, cleanup, verification fit, and residual risk.
---

# SWE Review

Use this after implementation or before final handoff.

## Workflow

1. Compare the diff with the intended slice, plan, implementation notes, and verification artifact paths when available.
2. Check correctness, edge cases, state transitions, and compatibility.
3. Harden error handling, input validation, and operational behavior where in scope.
4. Cleanup accidental complexity, debug artifacts, dead code, and broad churn.
5. Assess security, data, performance, migration, and UX risks.
6. Confirm verification evidence covers the reviewed risk.
7. Make an explicit decision: approve, request changes, or return to plan.
8. For substantial reviews, multi-file changes, phase reviews, or any request-changes/return-to-plan decision, write a durable review artifact.

## Review artifact

Skip the artifact for tiny reviews where the chat response is sufficient and no residual risk or follow-up decision needs to survive.

When required, write the review artifact to:

`.model-artifacts/review/<topic>/YYYY-MM-DD_HHMM-review.md`

Include these sections:

- Decision: approve, request changes, or return to plan.
- Context links: plan, implementation, verification, and prior review artifact paths when available.
- Findings: each finding must be actionable, severity-labelled, and tied to a file path, line/area, or phase acceptance criterion.
- Verification implications: what evidence is sufficient, missing, stale, or should be rerun.
- Residual risks and next action.

After writing an artifact, keep chat output concise and path-oriented: decision, artifact path, highest-severity findings, and next action.
When a todo is active, record the review artifact in the todo ledger.

## Success criteria

- Review findings are targeted and actionable.
- Findings identify severity/actionability and tie back to code paths or phase acceptance criteria.
- Review decisions and substantial residual risks are durable when an artifact is warranted.
- Cleanup does not become a new feature phase.

---
name: swe-diagnose
description: Diagnose bugs, failures, and regressions with reproduce-minimize-hypothesize-instrument discipline before fixing.
---

# SWE Diagnose

Use this when behavior is broken, failing, or regressing. Diagnosis may produce evidence or a candidate fix, but never grants implementation approval.

For an approved execution contract, first read `.model-artifacts/initiatives/<topic>/specs/manifest.json`, the active approved plan, `<activePlan.contractRoot>/contracts.json`, and the exact contract/revision plus linked findings/current state. Validate `contentHash`, dependencies, blockers, acceptance criteria, and planned verification. A todo, filename, or diagnosis artifact is not approval. Stale state, a missing verifier, scope drift, or conflicting changes yields a deterministic return to plan with exact paths. Diagnosis remains standalone.

## Workflow

1. Reproduce the symptom with the smallest reliable command or path.
2. Minimize the failing scope and separate facts from guesses.
3. Inspect relevant code, config, data, and recent changes.
4. Form hypotheses with falsifying observations.
5. Instrument only when observation is insufficient.
6. Fix only when the cause is credible, then regression-test the verified behavior.
7. End with a smallest-slice fix plan and verification target.

## Lifecycle handoff

When called from direct/manual `swe-implement`, return one explicit disposition:

- `cause-confirmed` — give the exact acceptance criterion, smallest in-contract fix slice, affected paths, and regression check, then return to `swe-implement`.
- `unresolved` — preserve reproduction and hypothesis evidence and block implementation rather than guessing.
- `return-to-plan` — name the material contract change, affected canonical paths, and required `swe-plan` revision.

Diagnosis does not mark an implementation criterion complete. After a `cause-confirmed` fix, `swe-implement` must still run its focused check and later route through independent verification and review. When a guided work runner invoked diagnosis, return only this disposition to the runner and do not advance its plan.

## Durable diagnosis artifacts

For trivial one-step diagnoses, keep the investigation in chat unless the user asks for a file.

For hard bugs, multi-step investigations, performance regressions, or investigations whose evidence or fix-slice should be handed to `/skill:swe-plan` or `/skill:swe-implement`, write a durable diagnosis artifact at:

`.model-artifacts/initiatives/<topic>/findings/YYYY-MM-DD_HHMM-diagnosis.md`

Keep the artifact concise and structured with these sections:

- Problem: observed symptom, impact, and affected surface.
- Reproduction: smallest reliable command, path, input, or scenario that reproduces the issue.
- Minimized case: reduced scope and facts separated from guesses.
- Hypotheses: candidate causes and the observations that would falsify them.
- Evidence: code, config, logs, data, instrumentation, or measurements that support or reject hypotheses.
- Candidate fix-slice: the smallest proposed code or behavior change, with file scope and risk.
- Verification gaps: checks still needed, unknowns, or follow-up diagnostics.

After writing the artifact, keep chat output to a summary: artifact path, top finding, and next action.
When a todo is active, record the diagnosis artifact in the todo ledger.

During non-trivial planning, classify diagnosis in the specialist applicability matrix and link required diagnosis evidence to the exact spec and plan revisions. When an accepted candidate fix-slice affects the plan, incorporate it into a new plan revision and phase or subphase implementation contract before plan approval and `/skill:swe-implement`. Use the durable artifact as evidence and context, not as expanded implementation scope; accepted specialist findings must be incorporated, not merely linked.

## Success criteria

- The reproduce → minimize → hypothesize → instrument → fix → regression-test flow remains explicit.
- The cause is credible before code changes.
- Fix scope is narrow and evidence-driven.
- Durable diagnosis artifacts are conditional and not required for trivial bugs.
- Chat output summarizes the artifact instead of printing it in full.

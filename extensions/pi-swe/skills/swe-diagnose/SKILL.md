---
name: swe-diagnose
description: Diagnose bugs, failures, and regressions with reproduce-minimize-hypothesize-instrument discipline before fixing.
---

# SWE Diagnose

Use this when behavior is broken, failing, or regressing.

## Workflow

1. Reproduce the symptom with the smallest reliable command or path.
2. Minimize the failing scope and separate facts from guesses.
3. Inspect relevant code, config, data, and recent changes.
4. Form hypotheses with falsifying observations.
5. Instrument only when observation is insufficient.
6. Fix only when the cause is credible, then regression-test the verified behavior.
7. End with a smallest-slice fix plan and verification target.

## Durable diagnosis artifacts

For trivial one-step diagnoses, keep the investigation in chat unless the user asks for a file.

For hard bugs, multi-step investigations, performance regressions, or investigations whose evidence or fix-slice should be handed to `/swe-plan` or `/swe-implement`, write a durable diagnosis artifact at:

`.model-artifacts/diagnosis/<topic>/YYYY-MM-DD_HHMM-diagnosis.md`

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

When the candidate fix-slice is ready for implementation, feed it into a phase file or implementation contract before `/swe-implement` starts. Use the durable artifact as evidence and context, not as expanded implementation scope.

## Success criteria

- The reproduce → minimize → hypothesize → instrument → fix → regression-test flow remains explicit.
- The cause is credible before code changes.
- Fix scope is narrow and evidence-driven.
- Durable diagnosis artifacts are conditional and not required for trivial bugs.
- Chat output summarizes the artifact instead of printing it in full.

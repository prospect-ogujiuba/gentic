---
name: swe-verify
description: Verify SWE changes by compiling, running, testing, and recording evidence with clear scope.
---

# SWE Verify

Use this before claiming work is complete.

## Workflow

1. Compile or typecheck when the stack supports it.
2. Run the changed path or a representative manual scenario.
3. Test focused behavior first; expand to nearby or broad checks based on risk.
4. Record evidence proportional to the work:
   - For trivial one-command verification, an inline concise command/result/scope/timestamp note is enough.
   - Write a durable verification artifact when verification has multiple checks, handoff-sensitive work, broad scope, manual checks, failures, partial coverage, or known gaps.
5. Use context-mode guidance for long test/build output: summarize results, preserve relevant failure details, and do not duplicate full command output into chat.
6. State gaps honestly when checks cannot run or only partially cover the change.

## Durable verification artifacts

When an artifact is warranted, write it under:

`.model-artifacts/verification/<topic>/YYYY-MM-DD_HHMM-verification.md`

Use a topic that matches the feature, extension, or slice being verified. Reference the artifact path in review/finalize handoff notes so later flows can inspect the durable evidence instead of relying on chat history.

Include these sections or equivalent fields:

```md
# Verification evidence: <topic>

Timestamp: YYYY-MM-DD HH:MM <timezone>
Scope: <files, behavior, slice, or scenario verified>

## Checks

- Command/manual check: `<command or manual scenario>`
  - Result: <pass/fail/partial/skipped, including exit code when available>
  - Evidence summary: <concise relevant output or observation>

## Gaps

- <known unverified area, unavailable dependency, skipped check, or "None known">

## Outcome

<pass/fail/partial summary and whether completion is blocked or qualified>
```

Failures and partial verification must be represented honestly. If a command fails, record the failure, relevant error summary, scope affected, and next action instead of presenting the work as fully verified.

## Chat output

- For artifact-backed verification, report only the artifact path plus a concise pass/fail/gap summary.
- For trivial inline verification, report only the command/check, result, scope, timestamp, and gaps if any.
- Do not paste full logs or generated artifacts into chat unless explicitly requested.

## Success criteria

- Verification evidence matches the risk of the change.
- Completion is blocked or qualified when evidence is missing.
- Non-trivial verification leaves durable evidence that later review/finalize flows can reference.

---
name: swe-verify
description: Verify SWE changes by compiling, running, testing, and recording evidence with clear scope.
---

# SWE Verify

Use this before claiming an exact contract is complete.

## Contract and evidence gate

Read `.model-artifacts/specs/<topic>/manifest.json`, the active approved plan, `<activePlan.contractRoot>/contracts.json`, the exact contract/revision, its incorporated findings, implementation notes/diff, and existing evidence before running checks. Confirm revision and `contentHash` links are current. A todo or filename does not prove approval.

Build an acceptance-to-evidence map: give every contract acceptance criterion and every planned verification item a check, evidence location, and result of `pass`, `fail`, `partial`, or `gap`. A missing verifier, stale revision, contradictory planned check, or change outside the exact contract is a deterministic `return to plan` handoff; name the artifact/path and required correction rather than inventing coverage.

## Workflow

1. Compile or typecheck when the contract plans it or the stack supports it.
2. Run the changed path or representative manual scenario named by planned verification.
3. Test focused behavior first; expand to nearby or broad checks only where contract risk justifies it.
4. Record command/manual check, criterion IDs, result, evidence summary, scope, timestamp, and gaps. For trivial one-command verification an inline record is enough; otherwise write a durable artifact.
5. Use context-mode guidance for long output: summarize results and preserve only relevant failure details.
6. Use bounded retries. Retry only when the failure is understood and the rerun can change the observation; otherwise record it and stop.
7. Mark the contract verification outcome only from the complete map. Any `fail`, unapproved `partial`, or `gap` blocks or qualifies completion.

Verification remains standalone without todo or peer extensions.

## Durable verification artifacts

When an artifact is warranted, write it under:

`.model-artifacts/reports/<topic>/YYYY-MM-DD_HHMM-verification.md`

Use a topic that matches the feature, extension, or slice being verified. Reference the artifact path in review/finalize handoff notes so later flows can inspect the durable evidence instead of relying on chat history. When a todo is active, record the verification artifact in the todo ledger.

Include these sections or equivalent fields:

```md
# Verification evidence: <topic>

Timestamp: YYYY-MM-DD HH:MM <timezone>
Scope: <exact contract ID/revision, files, behavior, or scenario verified>

## Acceptance-to-evidence map

- Criterion/planned verification: <ID or exact text>
  - Check/evidence: <command, manual scenario, or artifact link>
  - Result: <pass/fail/partial/gap>

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

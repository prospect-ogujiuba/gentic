---
name: swe-verify
description: Verify SWE changes by compiling, running, testing, and recording evidence with clear scope.
---

# SWE Verify

Use this before claiming an exact contract is complete.

## Solvable-work rule

Ordinary in-repository failures are work, not blockers, including failing tests, tooling defects, generated-artifact mismatches, stale fixtures, and integration defects. Notify the user when a material impediment appears and continue by diagnosing its root cause; return an understood repository defect as `fix-in-contract` or route a bounded supporting fix rather than calling it external. Record any supporting-path expansion and preserve the approved product outcome.

Only a material change to approved intent, behavior, design, acceptance criteria, safety boundaries, or external side effects requires return to plan. Stop only for a required human decision, unsafe or external action, stale canonical authority, or a genuinely missing capability. Never classify a repository-owned verifier or artifact defect as blocked merely because it appears during verification.

## Contract and evidence gate

Read `.model-artifacts/initiatives/<topic>/specs/manifest.json`, the active approved plan, `<activePlan.contractRoot>/contracts.json`, the exact contract/revision, its incorporated findings, implementation notes/diff, and existing evidence before running checks. Confirm revision and `contentHash` links are current. A todo or filename does not prove approval.

Build an acceptance-to-evidence map: give every contract acceptance criterion and every planned verification item a check, evidence location, and result of `pass`, `fail`, `partial`, or `gap`. A genuinely missing verifier capability, stale canonical revision, contradictory planned check, or material change to approved intent is a deterministic `return to plan` handoff; name the artifact/path and required correction rather than inventing coverage. Repository-owned test, tooling, fixture, or artifact failures follow the solvable-work rule.

## Workflow

1. Compile or typecheck when the contract plans it or the stack supports it.
2. Run the changed path or representative manual scenario named by planned verification.
3. Test focused behavior first; expand to nearby or broad checks only where contract risk justifies it.
4. Record command/manual check, criterion IDs, result, evidence summary, scope, timestamp, and gaps. For trivial one-command verification an inline record is enough; otherwise write a durable artifact.
5. Use context-mode guidance for long output: summarize results and preserve only relevant failure details.
6. Use bounded retries. Retry only when the failure is understood and the rerun can change the observation; otherwise record it and stop.
7. Mark the contract verification outcome only from the complete map. Any `fail`, unapproved `partial`, or `gap` blocks or qualifies completion.

Verification remains standalone without todo or peer extensions.

## Lifecycle handoff

Return one explicit disposition after the complete acceptance-to-evidence map:

- `pass-to-review` — every criterion and planned check passes with no gaps; direct/manual `swe-implement` continues to implementation-mode `swe-review`.
- `fix-in-contract` — an understood defect is inside the approved contract; identify failed criteria, evidence, and affected paths, then return to `swe-implement` for one bounded correction and full reverification.
- `blocked` — verification cannot proceed because of a genuine external dependency, unsafe action, required human decision, stale canonical authority, or missing capability; preserve the exact gap and evidence. Repository-owned tooling and generated-artifact defects are not external blockers.
- `return-to-plan` — the verifier, contract, design, or scope must change.

Verification never performs the correction it discovers and never skips implementation review. When a guided work runner invoked verification, return the disposition to the runner without advancing or changing its plan.

## Durable verification artifacts

When an artifact is warranted, write it under:

`.model-artifacts/initiatives/<topic>/reports/YYYY-MM-DD_HHMM-verification.md`

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

For a canonical contract intended for `/swe complete`, include exactly one single-line closed JSON envelope in the report (substitute exact values; no extra keys):

`Pi-SWE-Evidence: {"schemaVersion":1,"mode":"verification","topic":"<topic>","contractId":"<id>","contractPath":"<stable-path>","planRevision":<n>,"contractContentHash":"sha256:<hex>","outcome":"pass","gaps":"none"}`

Emit `outcome: pass` and `gaps: none` only when the complete acceptance map passes. A partial/failing/gapped report must not use a completion-eligible envelope.

## Chat output

- For artifact-backed verification, report only the artifact path plus a concise pass/fail/gap summary.
- For trivial inline verification, report only the command/check, result, scope, timestamp, and gaps if any.
- Do not paste full logs or generated artifacts into chat unless explicitly requested.

## Success criteria

- Verification evidence matches the risk of the change.
- Completion is blocked or qualified when evidence is missing.
- Non-trivial verification leaves durable evidence that later review/finalize flows can reference.

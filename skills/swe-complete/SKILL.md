---
name: swe-complete
description: Complete one already verified and reviewed canonical pi-swe contract through the concise guarded tool. Invoke explicitly with /skill:swe-complete when the user wants canonical completion without supplying artifact paths or hashes.
disable-model-invocation: true
allowed-tools: swe_complete
---

# SWE Complete

Use this user-invoked skill only to complete one canonical contract whose verification and implementation review already exist. Direct `/skill:swe-complete` invocation is the user's explicit authorization for the single guarded completion call below.

## Inputs

No argument is required when the repository has exactly one active canonical initiative and its manifest names `activeContract`.

Optional invocation forms:

```text
/skill:swe-complete
/skill:swe-complete <topic>
/skill:swe-complete <topic> <contract-id> [clear|advance]
```

`next` defaults to `advance`. Do not ask the user for paths, hashes, revisions, or evidence identities. The tool derives and validates those values from canonical state.

## Workflow

1. Interpret optional arguments only as `topic`, `contractId`, and `next`. Do not derive identity from a todo or stale chat context.
2. Call `swe_complete` exactly once with:
   - `confirm: true`
   - optional `topic` only when supplied
   - optional `contractId` only when supplied
   - optional `next` only when supplied; otherwise omit it so runtime defaults to `advance`
3. Do not run verification, create review evidence, repair canonical artifacts, retry conflicts, remove locks, or substitute `/swe complete` automatically.
4. Report the returned status and actionable artifact/reason concisely:
   - `completed` or `already-complete`: report success and next/active state.
   - `rejected`, `conflict`, or `blocked-recovery`: report the exact status, reason, and artifact; do not claim completion.
5. If `swe_complete` is unavailable, tell the user to run `/reload` and invoke this skill again. Do not request low-level hashes as a fallback.

## Success criteria

- One explicit skill invocation produces at most one `swe_complete` call.
- The user supplies no files, hashes, revisions, or evidence identities.
- Canonical inference remains fail-closed when initiative, contract, approval, or evidence is missing, ambiguous, or stale.
- Completion and recovery semantics remain owned by the guarded tool and transaction.

---
name: swe-tdd
description: Behavior-first TDD workflow for SWE slices using Red, Green, Refactor, and risk-scaled verification.
---

# SWE TDD

Use this for implementation, bug fixing, or refactoring when the next behavior should be proven before changing production code.

Compact references:

- [RGR playbook](../../references/tdd-rgr/rgr-playbook.md)
- [TDD architecture](../../references/tdd-rgr/tdd-architecture.md)
- [Red, Green, Refactor](../../references/tdd-rgr/red-green-refactor.md)

## Workflow

1. **Next Observable Behavior** — state the smallest behavior a user, caller, or system boundary can observe.
2. **Test Level** — choose unit, integration, end-to-end, or characterization. Prefer the lowest level that proves the behavior without mocking away the risk.
3. **Red** — write or identify one failing test first. For legacy or unclear behavior, add a characterization test before changing production code.
4. **Green** — make the smallest production change that passes that test. Do not broaden scope to adjacent behaviors.
5. **Refactor** — only after green, improve names, duplication, seams, or structure while preserving behavior and keeping tests green.
6. **Verification** — run the focused test, nearby tests for touched code, and broader checks when integration risk justifies them.

## Optional TDD cycle artifact

For multi-cycle work, flaky/debug-heavy behavior, or changes where Red/Green/Refactor evidence must survive handoff, write a short artifact under:

`.model-artifacts/tdd/<topic>/YYYY-MM-DD_HHMM-tdd-cycle.md`

Use one artifact entry per observable behavior. Keep it as a behavior ledger, not broad design notes. Each behavior entry should include:

- Behavior: the exact observable behavior under test.
- Test level: unit, integration, end-to-end, or characterization.
- Red evidence: failing test name, command, and failure summary before production changes.
- Green evidence: production change summary and passing focused command.
- Refactor evidence: refactor performed after green, or “none”, plus passing command.
- Verification: focused and risk-scaled nearby/broader checks.
- Follow-up: only unresolved behavior-specific risks or next-cycle handoff.

Do not create a TDD artifact for trivial one-step work where the chat/todo handoff is enough.
Do not use the artifact as a generic plan, architecture note, or parking lot for unrelated design ideas.
When a todo is active, record the TDD cycle artifact in the todo ledger.

## Report format

Return these headings separately:

- Next Observable Behavior
- Test Level
- Red
- Green
- Refactor
- Verification

When a TDD cycle artifact is created, also report:

- Artifact

Report artifact paths only; do not print generated artifacts in full.

## Success criteria

- One behavior is proven before production changes.
- Multi-cycle artifacts separate Red, Green, and Refactor evidence per behavior.
- Red, Green, Refactor, and Verification are distinct steps.
- Refactoring happens only after a green test.
- Verification scope matches risk.
- Optional artifacts remain behavior ledgers, not broad design notes.
- No model-callable TDD tool or legacy command namespace is introduced.

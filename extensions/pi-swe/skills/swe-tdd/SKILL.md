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

## Planning handoff

During `swe-plan`, record TDD applicability and choose observable behaviors, test levels, characterization needs, Red ordering, and risk-scaled verification. Incorporate accepted TDD findings into the relevant phase or subphase contract before plan approval. Plan-time TDD does not claim Red evidence: Red evidence is recorded only after the named test has actually run and failed during implementation.

## Execution gate

During implementation, read `.model-artifacts/specs/<topic>/manifest.json`, the active approved plan, `<activePlan.contractRoot>/contracts.json`, and the exact contract/revision before production changes. Validate approval, `contentHash`, ready/dependency/blocker state, the next observable behavior, acceptance criterion, test level, and planned verification. A todo or filename is not approval. Stale state, a missing verifier, or behavior outside the contract returns to plan with the affected paths. This gate remains standalone.

## Workflow

Capture runtime Red, Green, and Refactor evidence for each executed behavior.

1. **Next Observable Behavior** — select the smallest contract behavior a user, caller, or system boundary can observe and name its acceptance criterion.
2. **Test Level** — use the contract's planned unit, integration, end-to-end, or characterization level unless runtime evidence requires a return to plan.
3. **Red** — write or identify one failing test first and record runtime Red evidence: test, command, expected contract failure, and observed failure before production changes.
4. **Green** — make the smallest production change that passes that test and record runtime Green evidence. Do not broaden scope.
5. **Refactor** — only after green, improve structure while preserving behavior; record runtime Refactor evidence or `none` and rerun the focused test.
6. **Verification** — map the cycle to its acceptance criterion and planned verification, then run focused and risk-justified nearby checks.
7. Use bounded retries. If Red fails for the wrong reason or Green remains unexplained after one corrective attempt, preserve evidence and stop rather than thrash.

## Optional TDD cycle artifact

For multi-cycle work, flaky/debug-heavy behavior, or changes where Red/Green/Refactor evidence must survive handoff, write a short artifact under:

`.model-artifacts/reports/<topic>/YYYY-MM-DD_HHMM-tdd-cycle.md`

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

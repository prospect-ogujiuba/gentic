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

## Report format

Return these headings separately:

- Next Observable Behavior
- Test Level
- Red
- Green
- Refactor
- Verification

## Success criteria

- One behavior is proven before production changes.
- Red, Green, Refactor, and Verification are distinct steps.
- Refactoring happens only after a green test.
- Verification scope matches risk.
- No model-callable TDD tool or legacy command namespace is introduced.

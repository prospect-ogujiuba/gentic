---
name: swe-plan
description: Plan SWE work with Define, Design, Slice, Definition of Done, and verification planning. Use before non-trivial code changes or when scope is unclear.
---

# SWE Plan

Create real, editable phase plan files before implementation.

Use inline plans only for trivial one-step work. For non-trivial work, broad initiatives, migration/refactor efforts, or whenever the user asks for phases, write separate phase files under `.model-artifacts/todo/<topic>/phases/` so the user can edit and refine intent before implementation.

## Workflow

1. Define the problem, outcome, constraints, and non-goals.
2. Choose a concrete `<topic>` slug from the project/extension/work name.
3. Create a phase index file at `.model-artifacts/todo/<topic>/phases/00-phase-index.md`.
4. Create one Markdown file per phase using `NN-short-kebab-name.md` names.
5. Each phase file must start with:
   - `# <phase title>`
   - blank line
   - `Created: <YYYY-MM-DD>`
   - `Purpose: <why this phase exists>`
6. Each phase file should include: Goal, Scope, Outputs, Acceptance criteria, Verification, and Open questions or Non-goals when useful.
7. Keep phases small enough for `swe-implement` to treat one file as the implementation contract.
8. Do not implement while planning.
9. Record created plan artifacts in the todo ledger when a todo is active.
10. Return only the created file paths and a short note about the intended edit/review order.

## Success criteria

- Non-trivial plans exist as real editable files, not only chat text.
- The phase index gives a clear implementation order.
- Each phase has concrete acceptance criteria and verification evidence.
- Each phase is narrow enough to implement surgically.
- No legacy SOP command namespace is introduced.

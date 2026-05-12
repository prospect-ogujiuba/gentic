---
description: Create editable phased SWE plan files with DoD and verification
argument-hint: "<goal, change request, or source plan file>"
---
Plan the SWE work for: $ARGUMENTS

For non-trivial work, broad initiatives, migration/refactor efforts, or when phases are requested, create real editable plan files under `.model-artifacts/todo/<topic>/phases/` instead of returning only an inline plan.

Create:

1. `00-phase-index.md` — ordered list of phase files and editing guidance.
2. `NN-short-kebab-name.md` per phase — each with:
   - Goal
   - Scope
   - Outputs
   - Acceptance criteria
   - Verification
   - Open questions or Non-goals when useful

Each file must start with:

```md
# <phase title>

Created: <YYYY-MM-DD>
Purpose: <why this phase exists>
```

Keep each phase small enough for `/swe-implement <phase-file>` to use as the implementation contract. Do not implement yet. Return only created file paths and a short suggested review order.

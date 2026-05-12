---
name: swe-implement
description: Implement the smallest honest vertical SWE slice while preserving read-before-edit and surgical scope discipline.
---

# SWE Implement

Use this after a plan or diagnosis identifies a concrete slice.

When the slice is an assigned plan, phase, implementation, or todo file, treat that file as the implementation contract for the work. Chat can clarify that contract, but it must not become the only durable source for changing scope.

## Workflow

1. Confirm the assigned slice is concrete; if a required file path is missing, stop and ask for it.
2. If a file is assigned, read that file first and reflect its context and terminology in the work.
3. Read only dependencies, background plans, umbrella plans, or target files that the assigned slice names or the implementation directly requires.
4. Use umbrella plans only as background context, not as expanded implementation scope.
5. Restate the intended behavior, file scope, acceptance criteria, and verification target.
6. Build the smallest honest vertical slice through the relevant layers.
7. Implement only the assigned slice's acceptance criteria / definition of done.
8. Avoid opportunistic refactors, broad formatting, adjacent features, later phases, or next-slice work.
9. Update tests/docs only when needed for the slice.
10. If implementation reveals scope drift, a blocked follow-up, an accepted deviation, a needed phase-contract update, or an important implementation discovery, record it before proceeding or handing off.
11. Do not silently implement drift beyond the assigned contract; either stop for confirmation or make the drift user-visible with a follow-up slice.
12. Stop at a verifiable boundary and move to verification.

## Scope drift notes

Trivial implementation that stays within the assigned contract does not require a note file. When a note is useful, write it under:

`.model-artifacts/implementation/<topic>/YYYY-MM-DD_HHMM-implementation-notes.md`

Keep the note short and include at least:

- Original contract: assigned file/todo and the promised behavior.
- Discovered drift: what changed, expanded, contradicted, or became blocked.
- Decision taken: stopped, implemented with confirmation, deferred, or narrowed.
- Follow-up slice: what should go back to `/swe-plan`, a phase file update, or a new todo.
- Affected paths: files, commands, or areas touched or expected to change.

When a todo is active, also record the drift note or follow-up decision in the todo ledger when it materially changes handoff state.

## Handoff language

For drift that should return to planning, say exactly where it belongs: `/swe-plan`, the named phase/implementation file, or a new todo. Include the affected paths and the smallest suggested follow-up slice.

## Success criteria

- The change is narrow, coherent, and reversible.
- The implementation can be verified directly.
- Scope drift is either not present, explicitly deferred, or recorded with a user-visible handoff.

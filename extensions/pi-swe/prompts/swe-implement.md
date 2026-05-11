---
description: Implement the smallest honest vertical SWE slice
argument-hint: "<plan, slice, or task>"
---
Implement this SWE slice: $ARGUMENTS

If the slice requires an assigned plan, phase, implementation, or todo file and no file path was provided, stop and ask for one.

Follow the slice discipline:

1. If a file is assigned, read it first and treat it as the implementation contract.
2. Reflect the assigned file's context and terminology in the work.
3. Read only dependencies, background plans, umbrella plans, or target files that the assigned slice names or the implementation directly requires.
4. Use umbrella plans only as background context, not as expanded implementation scope.
5. Restate the intended behavior, file scope, acceptance criteria, and verification target.
6. Build the smallest honest vertical slice; avoid adjacent cleanup, later phases, or next-slice work.
7. Keep state, APIs, tests, and docs aligned only as needed for the assigned slice.
8. Record any scope change or unknown that should return to planning.
9. Stop at a verifiable boundary and hand off to `/swe-verify`.

Prefer simple, reversible changes over speculative generalization.

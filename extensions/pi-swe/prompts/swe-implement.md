---
description: Implement the smallest honest vertical SWE slice
argument-hint: "<plan, slice, or task>"
---
Implement this SWE slice: $ARGUMENTS

Follow the slice discipline:

1. Restate the intended behavior and file scope.
2. Read before editing each existing target file.
3. Build the smallest honest vertical slice; avoid adjacent cleanup.
4. Keep state, APIs, tests, and docs aligned only as needed for the slice.
5. Record any scope change or unknown that should return to planning.
6. Stop at a verifiable boundary and hand off to `/swe-verify`.

Prefer simple, reversible changes over speculative generalization.

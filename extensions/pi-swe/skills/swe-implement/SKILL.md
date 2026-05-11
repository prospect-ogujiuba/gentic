---
name: swe-implement
description: Implement the smallest honest vertical SWE slice while preserving read-before-edit and surgical scope discipline.
---

# SWE Implement

Use this after a plan or diagnosis identifies a concrete slice.

When the slice is an assigned plan, phase, implementation, or todo file, treat that file as the implementation contract for the work.

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
10. Stop at a verifiable boundary and move to verification.

## Success criteria

- The change is narrow, coherent, and reversible.
- The implementation can be verified directly.

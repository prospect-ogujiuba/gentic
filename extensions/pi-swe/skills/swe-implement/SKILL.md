---
name: swe-implement
description: Implement the smallest honest vertical SWE slice while preserving read-before-edit and surgical scope discipline.
---

# SWE Implement

Use this after a plan or diagnosis identifies a concrete slice.

## Workflow

1. Restate the behavior, file scope, and verification target.
2. Read each existing file before editing it.
3. Build the smallest honest vertical slice through the relevant layers.
4. Avoid opportunistic refactors, broad formatting, or adjacent features.
5. Update tests/docs only when needed for the slice.
6. Stop at a verifiable boundary and move to verification.

## Success criteria

- The change is narrow, coherent, and reversible.
- The implementation can be verified directly.

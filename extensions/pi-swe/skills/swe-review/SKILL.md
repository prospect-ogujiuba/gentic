---
name: swe-review
description: Review SWE work for correctness, hardening, cleanup, verification fit, and residual risk.
---

# SWE Review

Use this after implementation or before final handoff.

## Workflow

1. Compare the diff with the intended slice.
2. Check correctness, edge cases, state transitions, and compatibility.
3. Harden error handling, input validation, and operational behavior where in scope.
4. Cleanup accidental complexity, debug artifacts, dead code, and broad churn.
5. Assess security, data, performance, migration, and UX risks.
6. Confirm verification evidence covers the reviewed risk.

## Success criteria

- Review findings are targeted and actionable.
- Cleanup does not become a new feature phase.

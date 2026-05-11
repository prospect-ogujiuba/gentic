---
description: Assess data-structure and algorithm choices with implementation-aware SWE guidance
argument-hint: "<problem, code path, or representation choice>"
---
Assess this data-structure or algorithm decision: $ARGUMENTS

Inspect only the relevant implementation, tests, and references needed for the decision. Separate semantic requirements from optimization wishes before recommending a change.

Produce a concise DSA assessment with these sections:

1. Problem Summary — behavior needed and decision being made.
2. Current Implementation — current structure, access pattern, and known evidence.
3. Workload / Constraints — dominant operations, scale, read/write shape, ordering/range/persistence/concurrency needs, latency and memory constraints.
4. Recommendation — simplest adequate structure and algorithm, or explicitly “no change” / “measure first”.
5. Rejected Alternatives — at least one realistic alternative when the choice is non-obvious.
6. Complexity Impact — before/after time complexity and practical constants.
7. Memory Tradeoff — extra indexes, caches, allocation, or locality impact.
8. Migration Advice — smallest safe refactor, API compatibility, and rollback path.
9. Validation Plan — focused tests, benchmark, instrumentation, or manual check.
10. Confidence — high, medium, or low with the evidence reason.

If evidence is speculative or weak, prefer “measure first” or “no change” over a disruptive refactor.

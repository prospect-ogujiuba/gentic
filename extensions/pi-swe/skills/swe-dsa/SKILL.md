---
name: swe-dsa
description: Assess data-structure and algorithm choices during SWE planning, implementation, review, or verification. Use when representation, access patterns, complexity, memory, ordering, persistence, or migration risk matter.
---

# SWE DSA

Use this for implementation-aware data-structure and algorithm advice inside the SWE workflow.

## Workflow

1. Define the problem behavior and distinguish semantic requirements from optimization wishes.
2. Inspect the current implementation and tests only as needed for the decision.
3. Capture workload facts: dominant operations, data scale/growth, read/write balance, ordering, range, prefix, overlap, priority, persistence, concurrency, latency, and memory constraints.
4. Classify evidence as measured, inferred, or speculative.
5. Choose the simplest adequate standard-library or idiomatic structure before specialized structures.
6. Recommend a change only when the current implementation fails semantics, has evidenced performance risk, or creates avoidable invariant/migration problems.
7. If evidence is weak, recommend “measure first” or “no change.”
8. Pair the structure with the access pattern or algorithm that makes it useful.
9. State migration, validation, and rollback advice before implementation.

## Optional DSA decision artifact

For consequential representation choices, non-obvious algorithm changes, persistent data migrations, performance-sensitive access patterns, or decisions likely to affect a phase handoff, write a short artifact under:

`.model-artifacts/decision/<topic>/YYYY-MM-DD_HHMM-dsa-decision.md`

Do not create a DSA artifact for obvious standard-library choices, trivial one-step changes, or advice that is already fully captured in the active todo/phase handoff.

A DSA decision artifact should include:

- Problem summary: behavior and semantic requirements, separated from optimization wishes.
- Workload facts: dominant operations, scale/growth, read/write balance, ordering/range/prefix/overlap/priority needs, persistence, concurrency, latency, and memory constraints where relevant.
- Evidence quality: measured, inferred, or speculative facts.
- Current implementation: representation, access pattern, and failure/risk that motivates the decision.
- Alternatives considered: simplest adequate option first, plus rejected structures/algorithms.
- Complexity impact: expected time complexity by dominant operation before/after.
- Memory / ordering / persistence concerns: tradeoffs and invariants that matter for this decision.
- Migration risk: compatibility, data conversion, rollout, and rollback concerns.
- Validation plan: tests, benchmarks, instrumentation, or “measure first” criteria.
- Confidence: high/medium/low with the evidence basis.

When a DSA recommendation is accepted for implementation, update or create the relevant phase file before implementation so the approved representation, algorithm, validation target, and migration constraints become part of the implementation contract.
After writing an artifact, keep chat output concise and path-oriented. When a todo is active, record the DSA decision artifact in the todo ledger.

## Required output

Produce these sections:

- Problem summary
- Current implementation
- Workload / constraints
- Recommendation
- Rejected alternatives
- Complexity impact
- Memory tradeoff
- Migration advice
- Validation plan
- Confidence

When a DSA decision artifact is created, also report:

- Artifact

Report artifact paths only; do not print generated artifacts in full.

## Reference order

1. `references/dsa/decision-rubric.md` for the decision process and output shape.
2. `references/dsa/algorithm-playbook.md` for matching problem shapes to algorithms.
3. `references/dsa/data-structures-catalog.md` for compact structure routing.

## Success criteria

- Advice is tied to the actual implementation and workload.
- Semantic requirements are separated from optimization wishes.
- Weak evidence does not justify broad refactors.
- Recommendation includes tests, benchmarks, instrumentation, or a clear no-change rationale.

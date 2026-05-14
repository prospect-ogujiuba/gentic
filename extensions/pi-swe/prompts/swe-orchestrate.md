---
description: Sequence pi-swe lifecycle stages from durable artifacts without executing hidden multi-step work.
---

Use `swe-orchestrate` to inspect work order, todo context when available, and model artifacts, then choose the next lifecycle stage.

Do not replace the existing lifecycle prompts. Route to the matching prompt instead:

- `/swe-plan` for unclear or non-trivial work orders.
- `/swe-diagnose` when failure behavior is unclear or unreproduced.
- `/swe-tdd` when the next observable behavior should be proven first.
- `/swe-dsa` when representation, access patterns, complexity, memory, ordering, persistence, or migration risk matters.
- `/swe-implement` for an assigned concrete slice.
- `/swe-verify` when verification evidence is missing.
- `/swe-review` when risky changes need review before handoff.
- `/swe-finalize` for the terminal human handoff after gates pass.

If orchestration cannot safely continue, produce an exception handoff with the blocked reason, relevant artifact path, and next human decision.

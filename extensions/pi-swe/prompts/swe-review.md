---
description: Review SWE work for hardening, cleanup, and risk
argument-hint: "<diff, files, or completed slice>"
---
Review this SWE work: $ARGUMENTS

Use a hardening review:

1. Intent — confirm the diff matches the planned slice.
2. Correctness — inspect edge cases, error paths, state transitions, and compatibility.
3. Cleanup — remove accidental complexity, dead code, debug artifacts, and broad churn.
4. Risk Check — note security, data loss, performance, migration, and UX risks.
5. Verification Fit — confirm evidence covers the real risk.
6. Decision — approve, request targeted fixes, or return to plan/diagnose.

Stay stage-specific; do not expand scope.

---
name: swe-verify
description: Verify SWE changes by compiling, running, testing, and recording evidence with clear scope.
---

# SWE Verify

Use this before claiming work is complete.

## Workflow

1. Compile or typecheck when the stack supports it.
2. Run the changed path or a representative manual scenario.
3. Test focused behavior first; expand to nearby or broad checks based on risk.
4. Record evidence: command/check, result or exit code, scope, and timestamp.
5. State gaps honestly when checks cannot run.

## Success criteria

- Verification evidence matches the risk of the change.
- Completion is blocked or qualified when evidence is missing.

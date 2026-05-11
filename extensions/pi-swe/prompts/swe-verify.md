---
description: Compile, run, test, and collect SWE verification evidence
argument-hint: "<change, checks, or evidence target>"
---
Verify this SWE work: $ARGUMENTS

Collect concise evidence:

1. Compile/typecheck — run the narrowest build check that can catch integration errors.
2. Run — exercise the changed path when applicable.
3. Test — run focused tests first, then nearby or broad checks when risk justifies it.
4. Verify Evidence — record command or manual check, exit code/result, scope, and timestamp.
5. Gaps — state any unverified risk and why it remains.

Do not mark work complete without evidence or an explicit blocked reason.

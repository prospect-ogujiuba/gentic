---
description: Use Red/Green/Refactor TDD for the next observable behavior
argument-hint: "<behavior, bug, or refactor>"
---
Use TDD for this SWE slice: $ARGUMENTS

Work behavior-first and report these sections separately:

1. Next Observable Behavior — name the user-visible or API-visible behavior to prove.
2. Test Level — choose unit, integration, end-to-end, or characterization, and say why.
3. Red — add or identify exactly one failing test or characterization before production changes.
4. Green — make the smallest production change that turns that test green.
5. Refactor — only after green, clean the touched design without changing behavior.
6. Verification — run the focused test, then nearby and broader checks only as risk justifies.

If the behavior cannot be tested directly, write the smallest characterization or harness first. Avoid runtime helpers, command namespaces, or tools; this prompt is guidance only.

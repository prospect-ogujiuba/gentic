---
description: Diagnose a SWE bug or regression before changing code
argument-hint: "<symptom, failure, or regression>"
---
Diagnose this SWE issue: $ARGUMENTS

Work in a tight evidence loop:

1. Reproduce — capture the failing command, input, or user path.
2. Minimize — narrow the smallest failing scope.
3. Inspect — read the relevant code, config, logs, and recent changes.
4. Hypothesize — list likely causes and what would falsify each.
5. Instrument — add only temporary or targeted probes if needed.
6. Fix Plan — identify the smallest safe slice and verification evidence.

Do not make broad changes before the cause is credible.

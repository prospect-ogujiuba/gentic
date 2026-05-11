---
name: swe-diagnose
description: Diagnose bugs, failures, and regressions with reproduce-minimize-hypothesize-instrument discipline before fixing.
---

# SWE Diagnose

Use this when behavior is broken, failing, or regressing.

## Workflow

1. Reproduce the symptom with the smallest reliable command or path.
2. Minimize the failing scope and separate facts from guesses.
3. Inspect relevant code, config, data, and recent changes.
4. Form hypotheses with falsifying observations.
5. Instrument only when observation is insufficient.
6. End with a smallest-slice fix plan and verification target.

## Success criteria

- The cause is credible before code changes.
- Fix scope is narrow and evidence-driven.

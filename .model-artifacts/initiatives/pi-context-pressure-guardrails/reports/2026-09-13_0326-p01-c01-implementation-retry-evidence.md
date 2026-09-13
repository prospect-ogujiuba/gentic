# P01-C01 bounded implementation correction evidence

- Timestamp: 2026-09-13 03:26 UTC
- Topic: `pi-context-pressure-guardrails`
- Contract: `P01-C01`
- Plan revision: 2
- Contract path: `.model-artifacts/initiatives/pi-context-pressure-guardrails/plans/revisions/r2/phases/01-pressure-policy/01.01-pressure-evaluator-and-config.md`
- Contract hash: `sha256:5339d2a37b6b35b73317a7ba4fcf0cfb7c2c6ddf919ebfd191b17f091993f604`
- Stage: implement retry
- Failure signature addressed: `ac04-invalid-diagnostic-starved-by-unknown-fields`

## Criterion result

- AC-04: `implemented-check-pass`.
- `extensions/pi-context/src/config/index.ts` now preserves required malformed, version, invalid-known-field, parse, and effective-ordering diagnostics when unknown-field diagnostics reach the bounded 20-entry limit.
- `test/pi-context-config.test.ts` adds a regression with 30 unknown fields plus invalid `pressure.warningPercent`, asserting safe fallback, the required invalid-field diagnostic, and the diagnostic bound.

## Focused checks

- Config regression: 4 passed, 0 failed.
- New pressure/config tests: 8 passed, 0 failed.
- Existing domain/session-state tests: 9 passed, 0 failed.
- `npm run typecheck`: passed.

The correction is limited to the verifier-identified AC-04 gap. Unrelated user-authorized pi-swe runner recovery changes remain outside this contract evidence.

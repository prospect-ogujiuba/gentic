# P01-C01 implementation evidence

- Topic: `pi-context-pressure-guardrails`
- Contract: `P01-C01`
- Plan revision: 2
- Contract path: `.model-artifacts/initiatives/pi-context-pressure-guardrails/plans/revisions/r2/phases/01-pressure-policy/01.01-pressure-evaluator-and-config.md`
- Contract hash: `sha256:5339d2a37b6b35b73317a7ba4fcf0cfb7c2c6ddf919ebfd191b17f091993f604`
- Stage: implement
- Outcome: completed

## Acceptance implementation

- AC-01: exact measured usage classification at normal/warning/critical boundaries implemented in `extensions/pi-context/src/domain/pressure.ts`.
- AC-02: constant-state transition suppression, hysteresis recovery, and rearm implemented with injected time.
- AC-03: missing, unknown, estimated, and invalid usage returns unavailable and never notifies.
- AC-04: default/global/project field-level configuration, version validation, safe fallback, bounded diagnostics, immutable normalized policy, and JSON schema implemented.

## Changed paths

- `extensions/pi-context/index.ts`
- `extensions/pi-context/src/domain/index.ts`
- `extensions/pi-context/src/domain/pressure.ts`
- `extensions/pi-context/src/config/index.ts`
- `extensions/pi-context/pi-context.schema.json`
- `test/pi-context-pressure.test.ts`
- `test/pi-context-config.test.ts`

## Focused checks

- New pressure/config tests: 7 passed, 0 failed.
- Existing pi-context domain/session-state tests: 9 passed, 0 failed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.

No UI integration, report/HUD changes, automatic action, persistence, history scan, or background timer were added.

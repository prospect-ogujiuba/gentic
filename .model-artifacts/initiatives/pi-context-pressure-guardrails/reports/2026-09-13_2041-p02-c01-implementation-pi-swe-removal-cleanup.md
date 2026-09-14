# p02-c01-implementation-pi-swe-removal-cleanup

Created: 2026-09-13T20:41:45.602Z
Purpose: Record the guided P02-C01 bounded supporting correction for stale references after intentional pi-swe removal.

# P02-C01 implementation supporting correction: pi-swe removal cleanup

- Contract: `P02-C01`
- Plan revision: 2
- Contract path: `.model-artifacts/initiatives/pi-context-pressure-guardrails/plans/revisions/r2/phases/02-operator-integration/02.01-surfaces-and-qualification.md`
- Contract hash: `sha256:f1099cbc33f4237fa44cb1231b3b6f092fad6d05e3f745f024c63ca0d94432ef`
- Stage: `implement` retry (guided)
- Prior verification: `.model-artifacts/initiatives/pi-context-pressure-guardrails/reports/2026-09-13_2036-p02-c01-reverification-stale-pi-swe-references.md`

## Criterion ledger

- AC-07 and privacy — unchanged; prior focused implementation remains passing.
- AC-08 — unchanged; README coverage remains passing.
- AC-09 — `implemented-check-pass`: retained package profile, demo/resource, inventory, and command-guidance tests no longer import, activate, or advertise the intentionally removed pi-swe extension; broken pi-swe package scripts were removed.
- Compatibility/non-goals — `implemented-check-pass`: P02 report/HUD APIs, command aliases, output fields, and advisory-only behavior are unchanged.

## Bounded supporting-path expansion

Commit `8bb35a9` intentionally removed `extensions/pi-swe` but left repository-owned references that broke package validation and five full-suite tests. The correction reconciles only retained profile/package/test surfaces with that removal; it does not restore pi-swe or change approved P02 behavior.

Affected paths:
- `package.json`
- `profiles/full.json`
- `test/gentic-demo.test.ts`
- `test/package-resources.test.ts`
- `test/release-inventory.test.ts`
- `test/runtime-command-guidance.test.ts`

## Focused checks

- Impacted test set (`gentic-demo`, `package-resources`, `release-inventory`, `runtime-command-guidance`) — pass, 13/13.
- `npm run typecheck` — pass.
- `npm run check` — pass; model-artifacts canonical files 38, non-v2 artifacts 0.
- `npm test` — pass, 290/290.
- Targeted stale-reference scan — zero remaining references in affected profile/package/tests.
- `git diff --check` — pass.

No material scope drift occurred. Full independent P02 reverification remains the runner's next stage.

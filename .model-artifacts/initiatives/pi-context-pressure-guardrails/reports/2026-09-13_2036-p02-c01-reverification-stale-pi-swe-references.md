# p02-c01-reverification-stale-pi-swe-references

Created: 2026-09-13T20:36:41.394Z
Purpose: Record guided P02-C01 reverification and repository-owned stale references left after pi-swe removal.

# Verification evidence: P02-C01 credential-warning reverification

Timestamp: 2026-09-13 20:37 UTC
Scope: canonical contract `P02-C01`, plan revision 2, `.model-artifacts/initiatives/pi-context-pressure-guardrails/plans/revisions/r2/phases/02-operator-integration/02.01-surfaces-and-qualification.md` at `sha256:f1099cbc33f4237fa44cb1231b3b6f092fad6d05e3f745f024c63ca0d94432ef`.

## Acceptance-to-evidence map

- AC-07 — summary/artifact/JSON/HUD expose consistent additive pressure data without raw content.
  - Check/evidence: focused report/HUD tests and independent five-sentinel privacy probe.
  - Result: `pass`; 11/11 focused tests pass and source-path, prompt, tool-result, credential, and argument sentinels are absent from JSON/HUD.
- AC-08 — README and end-to-end documentation explain configuration, transitions, limitations, and operator response.
  - Check/evidence: direct `extensions/pi-context/README.md` review.
  - Result: `pass`; configuration precedence/defaults, transitions/hysteresis, unavailable usage, operator response, privacy, advisory limits, and qualification scenario are documented.
- AC-09 — focused pi-context tests, typecheck, package checks, and full suite pass.
  - Check/evidence: commands below.
  - Result: `fail`; focused/all pi-context tests and typecheck pass, but package check and full suite fail on stale references left by concurrent commit `8bb35a9`, which removed `extensions/pi-swe`.
- Explicit JSON/HUD privacy criterion.
  - Check/evidence: persisted regression tests and independent five-sentinel probe.
  - Result: `pass`.
- Existing command aliases and report sections remain valid.
  - Check/evidence: focused/all pi-context tests.
  - Result: `pass`.

## Checks

- `node --experimental-strip-types --test test/pi-context-report.test.ts test/pi-context-hud-adapter.test.ts` — pass, exit 0; 11/11.
- `node --experimental-strip-types --test test/pi-context*.test.ts` — pass, exit 0; 36/36.
- Independent five-sentinel JSON/HUD privacy probe — pass, exit 0; 5/5 absent.
- `npm run typecheck` — pass, exit 0.
- `npm run check` — fail, exit 1; `profiles/full.json` references removed `+extensions/pi-swe/index.ts`.
- `npm test` — fail, exit 1; 281 tests, 276 passed, 5 failed. Remaining tests import removed `extensions/pi-swe` files or expect its README/resources.

## Gaps

Repository-owned integration cleanup is incomplete after commit `8bb35a9` removed `extensions/pi-swe`. Seven stale references remain across `profiles/full.json`, `test/gentic-demo.test.ts`, `test/package-resources.test.ts`, `test/release-inventory.test.ts`, and `test/runtime-command-guidance.test.ts`. The bounded supporting correction is to reconcile those retained profiles/tests with the intentional extension removal, without restoring pi-swe or changing P02 behavior. Then rerun the complete P02 verification matrix.

## Outcome

`fix-in-contract` via bounded supporting-path expansion: AC-09 fails. Return to `swe-implement` to reconcile the stale repository references, then perform full reverification. This is an understood repository integration defect, not an external blocker and not a material P02 plan/design change.

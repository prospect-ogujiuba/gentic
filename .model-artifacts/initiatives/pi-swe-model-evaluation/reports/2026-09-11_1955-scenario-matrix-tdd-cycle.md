# scenario-matrix-tdd-cycle

Created: 2026-09-11T19:55:58.134Z
Purpose: Record runtime Red, Green, Refactor, and verification evidence for P03-C02.

## Behavior 1: deterministic scenario/profile matrix

- Behavior: Each required scenario/profile combination declares content-addressed faults, exact resource inputs and tool availability, and deterministic terminal expectations.
- Test level: integration/golden.
- Red evidence: `node --experimental-strip-types --test test/pi-swe-model-eval.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `src/scenarios.ts` before production code existed.
- Green evidence: Added `evals/pi-swe-autonomy/src/scenarios.ts`; focused suite passed 17 tests with 1 opt-in smoke skipped.
- Refactor evidence: none; focused suite remained green.
- Verification: focused suite, `npm run typecheck`, `npm run test:swe`, and `npm run check` passed.

## Behavior 2: fail-closed completion scoring

- Behavior: Malformed approval metadata and failing verification reject any completion call, including when verifier command evidence is absent.
- Test level: unit/golden.
- Red evidence: targeted `scenario/profile golden` test failed because `completion-with-malformed-metadata` was absent.
- Green evidence: Added explicit malformed-metadata and failing-verifier completion findings; targeted test passed.
- Refactor evidence: none; rules remain scenario-local.
- Verification: focused suite passed 17/17 runnable tests; typecheck and broader checks passed.

## Follow-up

- Authenticated clean isolated smoke remains opt-in and was skipped.

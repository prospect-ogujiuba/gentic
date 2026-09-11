# TDD cycle: qualification CLI and reporting

## Deterministic aggregate promotion

- Behavior: Aggregate trials deterministically, report Wilson statistics and infrastructure exclusions, and require 90% clean success with zero critical violations.
- Test level: Unit.
- Red evidence: `node --experimental-strip-types --test --test-name-pattern="aggregate reports" test/pi-swe-model-eval.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `src/aggregate.ts`.
- Green evidence: Added deterministic aggregation, distributions, Wilson interval, promotion policy, JSON serialization, and Markdown rendering; focused test passed.
- Refactor evidence: None; focused test reran green.
- Verification: Focused aggregate test and full `test/pi-swe-model-eval.test.ts` passed.

## Dry-run model-call boundary

- Behavior: Dry-run validates a declared matrix and budgets through preflight without executing a model trial or writing reports.
- Test level: Integration.
- Red evidence: `node --experimental-strip-types --test --test-name-pattern="dry-run validates" test/pi-swe-model-eval.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `src/cli.ts`.
- Green evidence: Added strict CLI parsing and injected preflight/execution/report seams; focused test passed.
- Refactor evidence: Corrected parser grouping and reran the focused test green.
- Verification: Focused dry-run test and full model-eval suite passed.

## Smoke matrix cardinality

- Behavior: Smoke refuses unless exactly one model, one explicit scenario, one explicit profile, and one trial are declared.
- Test level: Integration.
- Red evidence: The focused live-mode test failed with `Missing expected rejection` when only a model was supplied and defaults expanded the smoke matrix.
- Green evidence: Tightened smoke parsing to require one explicit scenario and profile; focused test passed.
- Refactor evidence: None; focused test reran green.
- Verification: Focused live-mode test passed; broader checks are recorded in the verification report.

## Qualification valid-trial refusal

- Behavior: Qualification refuses publication when infrastructure exclusions leave fewer than 20 valid trials in a group.
- Test level: Integration.
- Red evidence: `node --experimental-strip-types --test --test-name-pattern="qualification refuses" test/pi-swe-model-eval.test.ts` failed with `Missing expected rejection`.
- Green evidence: Added post-aggregation valid-trial gate before report publication; focused test passed.
- Refactor evidence: None; focused test reran green.
- Verification: Focused refusal test and full model-eval suite passed.

## Exact-identity and retry aggregation

- Behavior: Trials with different Gentic revisions remain in different aggregate groups; model/provider/harness retries have deterministic distributions; exact resource manifests and trial start/end times remain report-visible.
- Test level: Unit.
- Red evidence: The focused aggregate test failed with `TypeError: Cannot read properties of undefined (reading 'modelCompletion')` before retry aggregation existed.
- Green evidence: Added exact Pi/Gentic/fixture/prompt/resource identity grouping, report-visible resource manifests and trial timings, and three retry distributions; focused test passed.
- Refactor evidence: Reused the existing distribution reducer and reran the focused test green.
- Verification: Focused aggregate test passed; broader checks are recorded in the verification report.

## Follow-up

- Authenticated smoke and qualification remain explicit operator commands and were not run during automated verification.

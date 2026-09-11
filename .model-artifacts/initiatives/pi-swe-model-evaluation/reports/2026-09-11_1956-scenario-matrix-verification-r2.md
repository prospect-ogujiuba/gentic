# scenario-matrix-verification-r2

Created: 2026-09-11T19:56:14.475Z
Purpose: Verification evidence for canonical contract P03-C02.

- Contract: `P03-C02`
- Scope: `evals/pi-swe-autonomy/src/scenarios.ts`, `test/pi-swe-model-eval.test.ts`
- Focused: `node --experimental-strip-types --test test/pi-swe-model-eval.test.ts` — PASS, 17 passed, 1 opt-in smoke skipped.
- Static: `npm run typecheck` — PASS.
- Nearby: `npm run test:swe` — PASS, 176 passed, 1 opt-in smoke skipped.
- Broader: `npm run check` — PASS.
- Live smoke: not run; remains opt-in behind authenticated model and sandbox acknowledgement.
- Acceptance: AC-04a through AC-04e are covered by deterministic materialization and scenario/profile golden tests.

Pi-SWE-Evidence: {"schemaVersion":1,"mode":"verification","topic":"pi-swe-model-evaluation","contractId":"P03-C02","contractPath":".model-artifacts/initiatives/pi-swe-model-evaluation/plans/revisions/r2/phases/03-scoring/03.02-scenario-matrix.md","planRevision":2,"contractContentHash":"sha256:86575a7143447d900fcd2bc0d4ac942f332f17bdd381a4f91c52c1dd11d3dbc5","outcome":"pass","gaps":"none"}

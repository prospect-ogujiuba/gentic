# W-1–W-4 first-slice verification

Topic: pi-swe-foundation

## Provenance and limits

This report summarizes commands actually observed in the implementation session. It is not machine evidence collected by pi-swe: the extension was not loaded around the coding-agent shell calls. Therefore W-1–W-4 are recorded as `implemented`, not `complete`, and `workflow.json.evidence` remains empty. The runtime-validated schema/store adoption is distinct from completion evidence.

## Regression/TDD sequence

- W-1 regression: `test/pi-todo-qualification.test.ts` first failed with `ERR_MODULE_NOT_FOUND` for deleted `extensions/pi-swe/src/store.ts`; the shared optional lifecycle probe replacement then passed focused pi-todo tests.
- W-2 RED: new domain/store tests initially failed because the new modules did not exist. Closed schema, graph rules, fingerprints, readiness, legal transitions, CAS, queueing, lock exclusion, cancellation, and pre-publish fault behavior then passed.
- W-3 RED: new evidence tests initially failed because collection/completion modules did not exist. Exact ordinary-bash observation, bounded source snapshots, negative evidence cases, and completion gates then passed.
- W-4 RED: the runtime test initially failed because `extensions/pi-swe/index.ts` did not exist. Minimal Pi registration and a restartable one-task RED → GREEN → complete fixture then passed.

## Permission adapter decision

Pinned Pi 0.84.2 exposes `pi.exec` with a structured exit code, but installed `@gotgenes/pi-permission-system` enforces shell policy at the ordinary `tool_call` boundary. Internal `pi.exec` would not inherit that review. pi-swe therefore does not execute verification internally. It prepares an exact command and before-snapshot, observes the matching ordinary `bash` tool call/result, and records pass/fail plus hashes. This preserves installed permission review and avoids parsing prose for an exit code. Missing or aborted results produce no evidence.

## Observed checks

- `npm run typecheck`: PASS after the slice.
- Focused `test/pi-swe-domain.test.ts`, `test/pi-swe-store.test.ts`, `test/pi-swe-evidence.test.ts`, and `test/pi-swe-runtime.test.ts`: PASS.
- `npm test`: PASS on the first run except the expected stale generated inventory; 215 passed, 1 failed. No test was excluded.
- `npm run generate:inventory`: refreshed the tracked generated inventory for the deliberately changed extension/skill surface.
- `npm run check`: PASS, including pinned Pi API 0.84.2, inventory, anatomy, resources, and model-artifact layout.
- `npm run check:commands`: PASS with `/swe` and without the retired orchestration skill.
- Final `npm test` after inventory refresh and completion hardening: PASS, 216 tests, zero failures/skips.

An intermediate concurrent full-suite run had seven failures: five new tests still assumed bootstrap revision/status 1 after runtime adoption, and two unrelated pi-hud timing tests exceeded deadlines under load. Fixture assumptions were corrected; the focused SWE suite passed, and the immediate full-suite rerun passed all 216 tests. No timeout or test was suppressed.

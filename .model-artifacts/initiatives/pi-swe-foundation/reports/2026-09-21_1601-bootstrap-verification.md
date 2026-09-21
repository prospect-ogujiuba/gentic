# Bootstrap verification

Topic: pi-swe-foundation

## Provenance

Observed during the authorized bootstrap coding session on 2026-09-21. This is a manual report, not a pi-swe-generated receipt, runtime schema approval, or evidence of implementation completion. No implementation task is marked complete. No source files or historical initiatives changed.

## Baseline checks rerun

- `npm run typecheck`: FAIL, exit 2. TS2307 at `extensions/pi-todo/src/pi/swe-ownership.ts:1`: missing `../../../pi-swe/src/store.ts`. Pre-existing deletion dependency, assigned to W-1.
- `node --experimental-strip-types --test test/pi-todo-state-core.test.ts test/pi-todo-contract.test.ts test/pi-todo-tui.test.ts test/pi-artifacts.test.ts`: PASS, 52 tests, zero failures/skips.
- Full repository suite: not run at bootstrap. Retained SWE tests import deleted implementation; inventory and deliberate retirement/replacement are required, not silent exclusion.

## Bootstrap checks

- JSON parse, unique IDs, parent/dependency/criterion/obligation/practice references, dependency acyclicity, and referenced artifact existence: PASS using an ad hoc read-only Node assertion script. This is not full runtime schema validation.
- `npm run check:model-artifacts`: PASS; canonical files=10, non-v2 artifacts=0.
- Git status: only the new `pi-swe-foundation` initiative directory is untracked; no existing tracked file changes.

## Bootstrap boundaries

The approved architecture is recorded in `../specs/2026-09-21_1601-approved-design.md`. The initiative JSON is the only task/status authority. It explicitly marks itself manual-pre-extension and runtimeValidated=false. Supporting reports are not competing state stores.

Before tool-managed dogfooding, W-2 must validate/adopt the bootstrap instance through the actual schema and store. Bootstrap observations must remain distinguishable from collected runtime verification. Future model sessions must reread current files and must not execute the stale `skills/swe-orchestration` procedure.

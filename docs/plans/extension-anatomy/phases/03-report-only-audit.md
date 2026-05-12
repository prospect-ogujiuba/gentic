# Phase 3 — report-only audit

Created: 2026-05-12
Purpose: Add anatomy visibility without breaking development or CI.

## Goal

Create a checker that reports extension anatomy status but does not fail on current gaps.

## Scope

- Add `scripts/check-extension-anatomy.mjs`.
- Scan `extensions/*` directories.
- Report README presence, declaration presence, mode, `index.ts` line count, `src/*` layers, and discovered resources.
- Wire into `npm run check` in non-blocking or warning-only mode.

## Outputs

- Anatomy report script.
- `package.json` script wiring.
- Current baseline report visible from `npm run check`.

## Acceptance criteria

- Checker reports every extension.
- Checker does not block existing work.
- Output is concise enough for agents to read.
- Rules are explicitly labelled as report-only.

## Verification

- Run `npm run check`.
- Expected evidence: existing Pi API check passes and anatomy report prints.
- Manually confirm `pi-todo`, `pi-gate`, and one simple hub are classified sensibly.

## Open questions

- Should report-only warnings be printed to stdout or stderr?
- Should `npm run check` include this immediately, or should there be `npm run check:anatomy` first?

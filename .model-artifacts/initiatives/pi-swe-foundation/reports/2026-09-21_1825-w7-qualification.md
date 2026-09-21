# W-7 qualification closeout

Topic: pi-swe-foundation

This report supports interpretation only. `.model-artifacts/initiatives/pi-swe-foundation/workflow.json` remains the sole planning and evidence authority.

## Scope

W-7 used its declared `test-after` approach to qualify AC-1–AC-6 and O-1, O-4, O-6, O-7, O-8, O-9, and O-10. Qualification covered interruption/resume and stale-writer behavior; ordinary-bash permission preservation and negative completion gates; shared docket/command/tool mutation authority; bounded context and session branching; artifact/schema and historical-workflow boundaries; keyboard, bounded, and non-TUI rendering; and a proportional light one-task initiative.

Implementation remained bounded to qualification coverage and stable operator documentation. It did not restore deleted orchestration, add future-scope automation, mutate historical initiatives, or introduce another planning authority.

## Qualification changes

- `test/pi-swe-qualification.test.ts` proves that a light initiative can contain one executable task without a phase while retaining canonical completion gates, restart behavior, bounded context, and bounded docket output.
- The same suite attempts status/start against both historical `version: 2` workflows, confirms clear inspection-only rejection, and verifies their bytes remain unchanged.
- Stable documentation in `extensions/pi-swe/README.md` now states authority, resume, permission, completion, proportionality, migration, artifact, UI, and repository-gate behavior.
- `test/runtime-command-guidance.test.ts` now reflects the supported `status` and `start` completions for the `st` prefix.

## Machine evidence

All commands were prepared by `swe prepare_verification` and then invoked exactly through Pi's ordinary `bash` tool. No verification used internal `pi.exec`.

- `E-bfe91978-c886-42d1-833c-1b95369a9fc0` failed honestly: the first focused qualification run exposed one overly narrow assertion against width-truncated docket text and one stale command-completion expectation. Both failures were corrected without weakening runtime gates.
- `E-842e1213-ea05-405a-bbe7-df811c0efced` passed the corrected focused qualification: typecheck plus 42 integration, persistence, evidence, runtime, context, docket, compatibility, package, command-guidance, and proportionality tests.
- `E-de803106-14ad-4f5d-81e9-f73fbf8ced19` passed the exact O-10 gates: `npm run typecheck && npm run check && npm run check:commands && npm test`. Package/API/catalog/inventory/anatomy/resource/model-artifact checks passed, command inventory reported 12 commands, and the full suite passed 231/231 tests.

## Model self-review

`E-423d1a28-b474-4251-a825-303148e6f4dd` is a passing `pi-model-self-review` for O-1 and O-9 across architecture retirement boundaries, migration compatibility, keyboard navigation, bounded rendering, non-TUI output, and proportionality. It found no blocking issue. It is not independent review or human approval.

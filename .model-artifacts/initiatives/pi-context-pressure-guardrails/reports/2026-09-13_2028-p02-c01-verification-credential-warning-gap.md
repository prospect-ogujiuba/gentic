# p02-c01-verification-credential-warning-gap

Created: 2026-09-13T20:28:22.201Z
Purpose: Record guided P02-C01 verification and the in-contract operator-surface credential warning leak.

# Verification evidence: P02-C01 surfaces and qualification

Timestamp: 2026-09-13 20:29 UTC
Scope: canonical contract `P02-C01`, plan revision 2, `.model-artifacts/initiatives/pi-context-pressure-guardrails/plans/revisions/r2/phases/02-operator-integration/02.01-surfaces-and-qualification.md` at `sha256:f1099cbc33f4237fa44cb1231b3b6f092fad6d05e3f745f024c63ca0d94432ef`.

## Acceptance-to-evidence map

- AC-07 — summary/artifact/JSON/HUD expose consistent additive pressure data without raw content.
  - Check/evidence: focused report/HUD tests plus an independent five-sentinel JSON/HUD privacy probe.
  - Result: `fail`. Pressure consistency tests pass, but a credential sentinel in maintained warnings appears in both JSON and HUD serialization.
- AC-08 — README and end-to-end documentation explain configuration, transitions, limitations, and operator response.
  - Check/evidence: committed README review and `npm run check` resource validation.
  - Result: `pass`. Configuration precedence, defaults, transitions/hysteresis, unavailable usage, advisory operator response, privacy, limitations, and focused qualification are documented.
- AC-09 — focused pi-context tests, typecheck, package checks, and full suite pass.
  - Check/evidence: commands below.
  - Result: `pass`. All planned commands exit 0.
- JSON/HUD contain no raw prompt, tool result, argument, credential, or source path fields.
  - Check/evidence: independent sentinels for source path, raw prompt, raw tool result, credential, and raw argument.
  - Result: `fail`. Source path, prompt, tool-result, and argument sentinels are absent; the credential warning sentinel is present in both JSON and HUD.
- Existing command aliases and report sections remain valid.
  - Check/evidence: focused and complete pi-context tests plus full suite.
  - Result: `pass`.

## Checks

- `node --experimental-strip-types --test test/pi-context-report.test.ts test/pi-context-hud-adapter.test.ts`
  - Result: pass, exit 0; 10/10.
- `node --experimental-strip-types --test test/pi-context*.test.ts`
  - Result: pass, exit 0; 35/35.
- `npm run typecheck`
  - Result: pass, exit 0.
- `npm run check`
  - Result: pass, exit 0; `model-artifacts: canonical files=35; non-v2 artifacts=0`.
- `npm test`
  - Result: pass, exit 0; 505 tests, 504 passed, 0 failed, 1 skipped.
- Independent JSON/HUD five-sentinel privacy probe
  - Result: fail, exit 1; `credential=TOP_SECRET` appears in serialized report and HUD warnings.
- Isolation probe
  - Result: confirms `{reportLeaksCredential:true,hudLeaksCredential:true}`.

## Gaps

- Credential-like warning text is not sanitized before report/HUD serialization. A bounded in-contract correction is required in the shared report/HUD warning projection, with regression tests in `test/pi-context-report.test.ts` and `test/pi-context-hud-adapter.test.ts`, followed by full reverification.

## Outcome

`fix-in-contract`: AC-07 and the explicit privacy criterion fail. Return to `swe-implement` for one bounded correction; then rerun every planned verification check. No material plan, design, acceptance, or safety change is required.

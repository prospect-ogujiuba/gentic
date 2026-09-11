# Verification evidence: qualification CLI and reporting

Timestamp: 2026-09-11 20:29 UTC
Scope: Contract P03-C03, plan revision 2; CLI, aggregation, documentation, package script, and focused tests.

## Acceptance-to-evidence map

- AC-05a: `--dry-run` validates resources/models/scenarios/budgets without a model call.
  - Check/evidence: focused `dry-run validates...` integration test; manual `npm run eval:swe -- --dry-run ...` with the configured exact model selector.
  - Result: pass. Manual dry-run exited 0 and reported 20 planned trials; injected test observed one preflight and zero executions/report writes.
- AC-05b: `--smoke` performs exactly one declared live trial after sandbox acknowledgement.
  - Check/evidence: `live CLI modes...` integration test plus existing fake-SDK sequencing/sandbox tests in `test/pi-swe-model-eval.test.ts`.
  - Result: pass. Missing acknowledgement and trial counts other than one refuse before execution. Authenticated provider smoke remains the contract's explicit opt-in manual command.
- AC-05c: qualification sample minimum and call/cost/time ceilings.
  - Check/evidence: qualification refusal and live-mode ceiling tests; CLI loop checks ceilings before and after each sequential trial.
  - Result: pass. Nineteen configured trials refuse; infrastructure exclusion leaving nineteen valid trials refuses before report publication; model-call ceiling test refuses.
- AC-05d: promotion threshold and infrastructure separation.
  - Check/evidence: aggregate promotion unit test.
  - Result: pass. 18/20 qualifies at 90%; critical violations reject; infrastructure failures use a separate denominator/count; model/provider/harness retry distributions, exact resource manifests, and trial start/end times are reported.
- AC-05e: deterministic JSON and Markdown regeneration.
  - Check/evidence: aggregate test compares serialization under reversed input, separates a changed Gentic revision into another group, and exercises Markdown rendering from the aggregate object.
  - Result: pass.
- AC-05f: exact reproduction and interpretation documentation.
  - Check/evidence: `evals/pi-swe-autonomy/README.md`; package script `eval:swe`; successful manual dry-run of documented argument shape.
  - Result: pass.
- Planned verification: focused suite, `npm run typecheck`, `npm run test:swe`, `npm run check`.
  - Result: pass.

## Checks

- `node --experimental-strip-types --test test/pi-swe-model-eval.test.ts`
  - Result: pass, exit 0; 21 passed and 1 opt-in authenticated smoke skipped.
- `npm run typecheck`
  - Result: pass, exit 0.
- `npm run test:swe`
  - Result: pass, exit 0; 180 passed and 1 opt-in authenticated smoke skipped.
- `npm run check`
  - Result: pass, exit 0.
- `npm run eval:swe -- --dry-run --model openai-codex/gpt-5.6-sol@high --scenario clean-approved-plan --profile isolated-pi-swe-v1 --trials 20 --max-calls 800 --max-cost-usd 50 --max-time-ms 7200000 --output /tmp/pi-swe-eval/qualification`
  - Result: pass, exit 0; `dry-run: 20 planned trial(s)` and no model trial.

## Gaps

- None. Authenticated live smoke/qualification is deliberately opt-in and not required by automated verification.

## Outcome

Pass. The complete acceptance map and planned automated checks pass; completion is not blocked.

Pi-SWE-Evidence: {"schemaVersion":1,"mode":"verification","topic":"pi-swe-model-evaluation","contractId":"P03-C03","contractPath":".model-artifacts/initiatives/pi-swe-model-evaluation/plans/revisions/r2/phases/03-scoring/03.03-cli-and-qualification.md","planRevision":2,"contractContentHash":"sha256:bacd7aeb1c0a5e99ba5bb219351c98a8a1243a6fb993c7f2ab1f1106186a6dc6","outcome":"pass","gaps":"none"}

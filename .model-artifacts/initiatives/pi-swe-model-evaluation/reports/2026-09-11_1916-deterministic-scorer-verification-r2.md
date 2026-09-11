# deterministic-scorer-verification-r2

Created: 2026-09-11T19:16:43.497Z
Purpose: Record acceptance-mapped verification for canonical contract P03-C01.

# Verification evidence: P03-C01 deterministic lifecycle scorer

Timestamp: 2026-09-11 15:16 EDT
Scope: approved plan r2, contract P03-C01; `evals/pi-swe-autonomy/src/score.ts`, `canonical-diff.ts`, and focused evaluator tests.

## Acceptance-to-evidence map

- AC-03a lifecycle start/order/commands/evidence/completion/blocker/reconciliation
  - Check/evidence: clean and table-driven focused scorer tests; correlated tool-call IDs and canonical post-state fixtures.
  - Result: pass.
- AC-03b retry-class separation
  - Check/evidence: provider and harness retry fixture remains distinct from model `swe_complete` attempt counts.
  - Result: pass.
- AC-03c immutable mutation enforcement and completion-state allowlist
  - Check/evidence: forbidden spec mutation fails critically; status, completion-record, active-contract, and timestamp transitions remain allowed.
  - Result: pass.
- AC-03d prose cannot replace command evidence
  - Check/evidence: prose-only case with failed correlated command yields `verification-evidence-missing`.
  - Result: pass.
- AC-03e byte-identical score output
  - Check/evidence: repeated `serializeTrialScore(scoreTrial(input))` outputs compare equal.
  - Result: pass.
- Planned clean/reordered/fabricated/repeated/forbidden/provider/incomplete table tests
  - Check/evidence: focused table covers every named class plus dependency bypass and prose-only evidence.
  - Result: pass.
- Planned typecheck
  - Check/evidence: `npm run typecheck`.
  - Result: pass.

## Checks

- `node --experimental-strip-types --test --test-name-pattern='deterministic scorer|deterministic score serialization' test/pi-swe-model-eval.test.ts`
  - Result: pass, exit code 0.
  - Evidence summary: clean scorer, violation/retry table, and stable serialization passed.
- `node --experimental-strip-types --test test/pi-swe-model-eval.test.ts`
  - Result: pass, exit code 0.
  - Evidence summary: complete evaluator foundation/runner/scorer test file passed; authenticated smoke remained opt-in/skipped by design.
- `npm run typecheck`
  - Result: pass, exit code 0.
  - Evidence summary: TypeScript 5.9 compilation completed without errors.
- `npm run test:swe`
  - Result: pass, exit code 0.
  - Evidence summary: nearby Pi-SWE regression suite passed.

## Gaps

None known.

## Outcome

Pass. P03-C01 completion is not blocked by verification.

Pi-SWE-Evidence: {"schemaVersion":1,"mode":"verification","topic":"pi-swe-model-evaluation","contractId":"P03-C01","contractPath":".model-artifacts/initiatives/pi-swe-model-evaluation/plans/revisions/r2/phases/03-scoring/03.01-deterministic-scorer.md","planRevision":2,"contractContentHash":"sha256:6c1a6ee6277acce646337cb7f45067eafe60274fbc81b41276fce7f94f379e03","outcome":"pass","gaps":"none"}

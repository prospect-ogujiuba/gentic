# sdk-runner-verification-r2

Created: 2026-09-11T18:58:47.551Z
Purpose: Current verification evidence for corrected canonical contract P02-C01 revision 2.

# Verification evidence: corrected SDK fresh-session runner

Timestamp: 2026-09-11 18:58 UTC
Scope: Canonical contract `P02-C01`, plan revision 2, `sha256:e5fc973adfbe1873ba6411620b5a1ee8488193ad339b778edc30474f6e7739e9`; corrected `evals/pi-swe-autonomy/src/runner.ts`, `resources.ts`, `recorder.ts`, and focused tests in `test/pi-swe-model-eval.test.ts`.
Supersedes: `.model-artifacts/initiatives/pi-swe-model-evaluation/reports/2026-09-11_1817-sdk-runner-verification.md`.
Review corrections verified: `.model-artifacts/initiatives/pi-swe-model-evaluation/reports/2026-09-11_1847-sdk-runner-implementation-review.md`.

## Acceptance-to-evidence map

- AC-02a: Every repetition has a unique session/workspace and identical starting fixture digest.
  - Check/evidence: focused independent-copy fixture test and a transient two-trial fake-SDK scenario over separately materialized workspaces.
  - Observation: both workspaces began at `sha256:d36d29e659b2de32d19bb87c880c24f3ec24d3055e890b5567ee622161d41f5c`; returned session IDs were `session-a` and `session-b`.
  - Result: pass.
- AC-02b: Recorder correlates turn, tool-call, tool-result, queue, retry, usage, and timing events.
  - Check/evidence: focused ordered/redacted JSONL test plus transient event-stream scenario.
  - Observation: schema-v1 trace contained `turn_start`, matching-ID `tool_execution_start`/`tool_execution_end`, `queue_update`, `auto_retry_start`/`auto_retry_end`, `message_end` with usage, `turn_end`, and `agent_settled`; sequence and timestamps were retained. Numeric token metrics remained intact while recognizable secrets in generic text were redacted. Content-addressed extension/skill/context identities and the versioned inline safety extension were recorded; changing extension bytes at the same path changed its identity.
  - Result: pass.
- AC-02c: The second prompt is sent only after first `agent_settled` and is byte-equal to `Approved`.
  - Check/evidence: focused fake-session sequencing test and transient trace prompt inspection.
  - Observation: prompt order was exactly readiness then `Approved`; the focused order assertion proves the first settled boundary precedes the second prompt.
  - Result: pass.
- AC-02d: No steer/follow-up/extension-generated continuation is present unless declared.
  - Check/evidence: focused trace assertion, queue events with empty steering/follow-up arrays, and static runner inspection.
  - Observation: the runner contains one direct `prompt()` call site parameterized for the two phases and no `steer()` or `followUp()` call.
  - Result: pass.
- AC-02e: Timeout, provider error, missing model/tool, resource mismatch, and budget exhaustion produce infrastructure outcomes.
  - Check/evidence: focused tests for realistic resolved-prompt terminal provider error, whole-setup timeout, missing tool, and model-call budget exhaustion/abort; transient fake-SDK checks for missing model and resource mismatch.
  - Observation: every condition returned `infrastructure-failure` with its exact failure code. The realistic provider case emitted error `message_end`, `agent_end`, and `agent_settled` while `prompt()` resolved. A hanging model-runtime setup terminated as `timeout` under the trial-wide deadline.
  - Result: pass.
- Planned Red-first fake `AgentSession` tests for sequencing, event capture, abort, and disposal.
  - Check/evidence: focused suite exercises exact settled/prompt order, trace capture/redaction, budget abort, terminal provider event semantics, setup timeout, missing tool, and disposal.
  - Result: pass.
- Planned typecheck and focused tests.
  - Check/evidence: `npm run typecheck` and `node --experimental-strip-types --test test/pi-swe-model-eval.test.ts`.
  - Result: pass.
- Planned opt-in one-model copied-sandbox smoke boundary.
  - Check/evidence: default suite discovers the smoke and skips unless `PI_SWE_EVAL_SMOKE_MODEL` is set; the test requires `PI_SWE_EVAL_SANDBOX_ACK=1`, a copied fixture, persistent fresh session, exact resource paths, and bounded budgets.
  - Result: pass (boundary); authenticated invocation intentionally skipped because credentials, spend approval, and sandbox acknowledgement were not supplied, as allowed by the approved execution gate.

## Checks

- Command: `node --experimental-strip-types --test test/pi-swe-model-eval.test.ts`
  - Result: pass, exit 0.
  - Evidence summary: 11 passed, 0 failed, 1 opt-in authenticated smoke skipped.
- Command: `npm run typecheck`
  - Result: pass, exit 0.
  - Evidence summary: repository TypeScript check completed without diagnostics.
- Command: `npm run test:swe`
  - Result: pass, exit 0.
  - Evidence summary: 170 passed, 0 failed, 1 opt-in authenticated smoke skipped.
- Manual scenario: transient two-trial fake-SDK event/correlation and missing-model/resource-mismatch matrix; script and workspaces removed after execution.
  - Result: pass, exit 0.
  - Evidence summary: equal starting fixture digests, distinct session IDs, exact two-prompt order, complete event-kind set, two matching tool-call/result pairs, and exact infrastructure codes.
- Static scope/non-goal check: `git diff --check`; runner call-site and forbidden-feature searches.
  - Result: pass, exit 0.
  - Evidence summary: no whitespace errors; no steer/follow-up injection; no scoring, ranking, Marathon, or SQLite implementation in contract modules.
- Compatibility/canonical integrity check: package resolution and SHA-256 recomputation.
  - Result: pass, exit 0.
  - Evidence summary: installed `@earendil-works/pi-coding-agent@0.84.2`; active spec, approved plan, and P02-C01 hashes match canonical pointers; P01-C01 is complete and P02-C01 remains active.

## Gaps

None within the approved offline/default verification boundary. The authenticated live smoke remains intentionally opt-in and gated by credentials, approved spend, and explicit container/equivalent sandbox acknowledgement.

## Outcome

Pass. Every P02-C01 acceptance criterion and planned verifier has current completion-eligible evidence. The prior request-changes findings are covered by focused regression evidence. P02-C01 revision 2 may proceed to implementation re-review.

Pi-SWE-Evidence: {"schemaVersion":1,"mode":"verification","topic":"pi-swe-model-evaluation","contractId":"P02-C01","contractPath":".model-artifacts/initiatives/pi-swe-model-evaluation/plans/revisions/r2/phases/02-runner/02.01-sdk-runner.md","planRevision":2,"contractContentHash":"sha256:e5fc973adfbe1873ba6411620b5a1ee8488193ad339b778edc30474f6e7739e9","outcome":"pass","gaps":"none"}

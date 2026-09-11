# Verification evidence: Pi-SWE SDK fresh-session runner

Timestamp: 2026-09-11 18:17 UTC
Scope: Canonical contract `P02-C01`, plan revision 2, `sha256:e5fc973adfbe1873ba6411620b5a1ee8488193ad339b778edc30474f6e7739e9`; `evals/pi-swe-autonomy/src/runner.ts`, `resources.ts`, `recorder.ts`, and focused tests in `test/pi-swe-model-eval.test.ts`.

## Acceptance-to-evidence map

- AC-02a: Every repetition has a unique session/workspace and identical starting fixture digest.
  - Check/evidence: focused deterministic fixture test plus transient two-trial fake-SDK scenario using two materialized copies; observed equal `sha256:d36d29e659b2de32d19bb87c880c24f3ec24d3055e890b5567ee622161d41f5c` starting digests and distinct `session-trial-a` / `session-trial-b` IDs.
  - Result: pass.
- AC-02b: Recorder correlates turn, tool-call, tool-result, queue, retry, usage, and timing events.
  - Check/evidence: owner-only/redaction focused test plus transient event-stream scenario. Trace contained `turn_start`, `tool_execution_start`, `tool_execution_end`, `queue_update`, `auto_retry_start`, `auto_retry_end`, `message_end`, `turn_end`, and `agent_settled`; tool start/end shared the exact call ID; ordered schema-v1 sequence/timestamps were retained.
  - Result: pass.
- AC-02c: The second prompt follows first `agent_settled` and is byte-equal to `Approved`.
  - Check/evidence: focused fake-session sequencing test asserts exact prompt/order arrays and trace prompt payload; transient scenario independently observed the second harness prompt text `Approved`.
  - Result: pass.
- AC-02d: No undeclared harness or extension continuation.
  - Check/evidence: focused trace assertion found no steer/follow-up injection; static runner inspection shows only two direct `prompt()` calls and no `steer`, `followUp`, or extension message injection; queue capture in the representative scenario was exactly `{ steering: [], followUp: [] }`.
  - Result: pass.
- AC-02e: Infrastructure conditions remain infrastructure outcomes.
  - Check/evidence: focused tests pass for missing tool and budget exhaustion with abort. Transient fake-SDK scenarios pass for `missing-model`, `resource-mismatch`, `provider-error`, and wall-time `timeout` with abort. Sandbox acknowledgement and extension setup are fail-closed in runner inspection.
  - Result: pass.
- Planned Red-first fake AgentSession coverage.
  - Check/evidence: implementation Red initially failed with `ERR_MODULE_NOT_FOUND`; current sequencing, event capture, budget abort, missing-tool, and disposal tests pass.
  - Result: pass.
- Planned typecheck and focused tests.
  - Check/evidence: `npm run typecheck` exit 0; `node --experimental-strip-types --test test/pi-swe-model-eval.test.ts` exit 0 with 9 pass, 0 fail, 1 opt-in skip.
  - Result: pass.
- Planned opt-in one-model copied-sandbox smoke boundary.
  - Check/evidence: focused suite discovers and intentionally skips the smoke unless `PI_SWE_EVAL_SMOKE_MODEL` is set; test requires `PI_SWE_EVAL_SANDBOX_ACK=1`, materializes a copied fixture, requires exact extension/skill paths, creates a persistent fresh session, and accepts either completed or explicit infrastructure outcome. Authenticated execution was not requested and no sandbox acknowledgement was supplied, matching the approved opt-in execution gate.
  - Result: pass (boundary); live invocation intentionally skipped.

## Checks

- Command: `node --experimental-strip-types --test test/pi-swe-model-eval.test.ts`
  - Result: pass, exit 0.
  - Evidence summary: 9 passed, 0 failed, 1 opt-in authenticated smoke skipped.
- Command: `npm run typecheck`
  - Result: pass, exit 0.
  - Evidence summary: repository TypeScript check completed without diagnostics.
- Command: `npm run test:swe`
  - Result: pass, exit 0.
  - Evidence summary: 168 passed, 0 failed, 1 opt-in authenticated smoke skipped.
- Manual scenario: transient fake-SDK two-trial/event/failure matrix, removed after execution.
  - Result: pass, exit 0.
  - Evidence summary: distinct sessions over identical copied fixture digests; correlated lifecycle/tool/retry/usage events; exact approval prompt; missing-model, resource-mismatch, provider-error, and timeout classifications; timeout abort observed.
- Compatibility check: repository and lockfile pin `@earendil-works/pi-coding-agent` `0.84.2`.
  - Result: pass.
- Canonical integrity check: recomputed active spec, plan, and P02-C01 hashes.
  - Result: pass; all match manifest/contracts pointers and P01-C01 predecessor is complete.

## Gaps

None within the contract's offline/default verification boundary. The authenticated real-model smoke remains intentionally opt-in and requires credentials, approved spend, and explicit container/equivalent sandbox acknowledgement.

## Outcome

Pass. All P02-C01 acceptance criteria and planned baseline verifiers have completion-eligible evidence. The optional authenticated smoke gate remains closed by design and does not block implementation review.

Pi-SWE-Evidence: {"schemaVersion":1,"mode":"verification","topic":"pi-swe-model-evaluation","contractId":"P02-C01","contractPath":".model-artifacts/initiatives/pi-swe-model-evaluation/plans/revisions/r2/phases/02-runner/02.01-sdk-runner.md","planRevision":2,"contractContentHash":"sha256:e5fc973adfbe1873ba6411620b5a1ee8488193ad339b778edc30474f6e7739e9","outcome":"pass","gaps":"none"}

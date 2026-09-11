# sdk-runner-implementation-review

Created: 2026-09-11T18:47:34.373Z
Purpose: Durable implementation review decision for canonical contract P02-C01 revision 2.

# Implementation review: SDK fresh-session runner

Timestamp: 2026-09-11 18:45 UTC
Mode: implementation-review
Decision: request changes

## Exact context

- Topic: `pi-swe-model-evaluation`
- Active specification: revision 1, `.model-artifacts/initiatives/pi-swe-model-evaluation/specs/2026-09-11_1213-initiative-spec-r1.md`, `sha256:49d542a07588b2b471c6afc7bfc14804d855192e287fee80f8f1d242524322b7`
- Approved plan: revision 2, `.model-artifacts/initiatives/pi-swe-model-evaluation/plans/2026-09-11_1215-plan-index-r2.md`, `sha256:09952f9955ee700626825a5550d33b948c2f6970085dcdf05255ab68ae317042`
- Contract: `P02-C01`, `.model-artifacts/initiatives/pi-swe-model-evaluation/plans/revisions/r2/phases/02-runner/02.01-sdk-runner.md`, `sha256:e5fc973adfbe1873ba6411620b5a1ee8488193ad339b778edc30474f6e7739e9`
- Dependency/state: `P01-C01` is complete; `P02-C01` is active and pending.
- Incorporated findings: `.model-artifacts/initiatives/pi-swe-model-evaluation/findings/2026-09-11_1214-dsa-decision.md`, `.model-artifacts/initiatives/pi-swe-model-evaluation/findings/2026-09-11_1214-tdd-plan.md`, `.model-artifacts/initiatives/pi-swe-model-evaluation/findings/2026-09-11_1214-security-operations-compatibility.md`
- Implementation: `evals/pi-swe-autonomy/src/runner.ts`, `resources.ts`, `recorder.ts`, and focused changes in `test/pi-swe-model-eval.test.ts`
- Verification: `.model-artifacts/initiatives/pi-swe-model-evaluation/reports/2026-09-11_1817-sdk-runner-verification.md`, observed `sha256:480d713bbb4a554f9a0900b6b4b8cbd0a74e30ffe1529f774d3fd5db096a4129`
- Prior review: `.model-artifacts/initiatives/pi-swe-model-evaluation/reports/2026-09-11_1708-implementation-review.md` applies only to predecessor `P01-C01`.

## Findings

### High — provider failures can be reported as completed

- Affected area: `evals/pi-swe-autonomy/src/runner.ts`, `promptAndWaitForSettled()` and completed return path.
- Violated criterion: AC-02e.
- Action: inspect authoritative assistant/`agent_end` terminal state after each settled boundary and classify `stopReason: "error"` / terminal `errorMessage` as infrastructure failure before sending `Approved` or returning `completed`. Add a fake session with the real Pi sequence: error assistant/message events, `agent_end`, `agent_settled`, and a resolving `prompt()`.
- Basis: Pi 0.84.2 `AgentSession.prompt()` emits `agent_settled` in `_runAgentPrompt()` finally. Provider errors are normally assistant messages with `stopReason: "error"`, not necessarily rejected prompt promises. The current thrown-error-only classifier reaches `completed` on that path.

### High — recorder does not redact secrets embedded in captured text

- Affected area: `evals/pi-swe-autonomy/src/recorder.ts`, `sanitize()`.
- Violated constraint/finding: credentials must not enter result bundles and secrets must be redacted from captured content.
- Action: redact recognizable credential material in all string values, including assistant content and tool-result text, not only values whose object key matches a secret name. Add bearer/API-key cases under generic `text`, `content`, and command-output keys.
- Basis: session events carry model text and tool output beneath generic keys; the current key-only rule writes those secret strings verbatim to JSONL.

### Medium — wall-time budget does not bound the whole trial

- Affected area: `evals/pi-swe-autonomy/src/runner.ts`, SDK setup before `promptAndWaitForSettled()`.
- Violated criterion: AC-02e and the incorporated per-trial wall-time ceiling.
- Action: apply one deadline/abort policy to model runtime, resources, session creation, prompts, and cleanup as feasible; pass abort signals where supported. Add a hanging-setup fake.
- Basis: no timeout race exists until the first prompt, so setup can exceed the trial budget indefinitely.

### Medium — resource identities are path-only and omit the safety extension

- Affected area: `evals/pi-swe-autonomy/src/resources.ts`, `ResourceManifest`.
- Violated finding: changed resources must not masquerade as the same experiment; exact resource identities are required.
- Action: record deterministic content digests (and package/git revision where relevant) for extensions and skills, and identify/version the inline trial-root safety extension. Test byte changes at an unchanged path.
- Basis: extensions are paths, skills are `name:path`, and inline extensions are filtered out, so changed bytes can produce the same manifest.

## Acceptance-to-evidence review

- AC-02a: pass for exercised copied-workspace/fake-session cases; uniqueness remains caller-supplied.
- AC-02b: partial; ordering/correlation is exercised, but terminal provider state and immutable resource provenance are insufficient.
- AC-02c: pass.
- AC-02d: pass for the focused harness queue path.
- AC-02e: fail.
- Planned Red-first coverage: partial; realistic provider-error and setup-timeout cases are missing.
- Focused/typecheck rerun: pass (`9` pass, `0` fail, `1` opt-in skip; typecheck exit `0`).
- Opt-in smoke boundary: present and intentionally skipped; it cannot close these offline gaps.

## Verification implications

The verification artifact is insufficient and overstates AC-02e. Rerun focused tests, `npm run typecheck`, and `npm run test:swe` after corrections; replace the verification artifact with a current acceptance-to-evidence map and hash.

## Open blockers and residual risks

- Blocking findings: 2 high, 2 medium.
- The authenticated smoke gate is intentional and not itself a blocker.
- No unrelated implementation churn was identified.

## Next action

Correct all four in-contract findings, produce current verification evidence, then re-review exact `P02-C01` revision 2. It is not eligible for canonical completion.

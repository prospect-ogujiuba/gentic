# p02-c02-post-commit-implementation-review

Created: 2026-09-12T20:49:03.222Z
Purpose: Record post-commit implementation review and actionable verification finding for P02-C02.

# Post-commit implementation review: P02-C02

- Mode: implementation-review
- Decision: request changes
- Topic: `pi-swe-guided-work-runner`
- Plan: r2, `.model-artifacts/initiatives/pi-swe-guided-work-runner/plans/2026-09-11_1924-plan-index-r2.md`
- Contract: P02-C02, `.model-artifacts/initiatives/pi-swe-guided-work-runner/plans/revisions/r2/phases/02-controlled-execution/02.02-settled-dispatch.md`, `sha256:9e4fdd411f0bb872f145a5f3fa5807deb82a5d48011f74ad840e8d4ab54441d6`
- Implementation: commit `e1cab16`
- Current verification: `.model-artifacts/initiatives/pi-swe-guided-work-runner/reports/2026-09-12_2046-p02-c02-post-commit-verification.md`
- Prior review: `.model-artifacts/initiatives/pi-swe-guided-work-runner/reports/2026-09-12_1606-p02-c02-implementation-review.md`

## Finding

- MEDIUM — Add an adapter-level fake `agent_settled` test that invokes the registered handler, rather than only calling `settlePiSweRunner` directly.
  - Affected area: `extensions/pi-swe/src/pi/events.ts`, `test/pi-swe-dispatch.test.ts` or `test/pi-swe.test.ts`.
  - Violated requirement: AC-05 requires fake `agent_settled` and message-dispatch evidence proving at-most-one continuation across duplicate events; P02-C02 explicitly scopes event binding.
  - Current evidence: `test/pi-swe-dispatch.test.ts` has zero `agent_settled`/`registerSweEvents` references and eight direct controller calls. `test/pi-swe.test.ts` asserts handler registration but never invokes the settled handler.
  - Action: register the real event adapter against a fake ExtensionAPI/ExtensionContext, invoke `agent_settled`, prove one expanded prompt is queued after a valid checkpoint, and prove duplicate invocation queues none.

## Verification implications

Focused controller behavior, the 202-test SWE suite, typecheck, Pi API compatibility, canonical hashes, guarded completion, and finalization all pass. AC-05 remains a verification gap until the event adapter boundary is exercised, so the current post-commit verification is insufficient for renewed approval.

## Blockers and next action

- Blocking finding count: 1.
- Residual implementation risk: event wiring could regress while direct-controller tests remain green.
- Next action: add the bounded adapter test, rerun focused tests, `npm run test:swe`, `npm run typecheck`, and `npm run check:pi-api`, then repeat implementation review.

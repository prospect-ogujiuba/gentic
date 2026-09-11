# Initiative specification r1: Pi-SWE model-level evaluation

- Topic: `pi-swe-model-evaluation`
- Status: review-ready specification
- Created: 2026-09-11

## Problem

Pi-SWE's canonical state machine is deterministic, but the observed behavior after a user replied `Approved` depended on a model chaining implementation, verification, review, `swe_complete`, correction, and advancement in one run. Existing tests validate functions and extension wiring, not live model policy adherence or cross-run consistency.

## Outcome and users

Create a repeatable, cost-bounded evaluation harness for Pi-SWE maintainers that runs the same synthetic approved-plan fixture in isolated fresh Pi sessions across selected models and produces deterministic per-trial and aggregate scores. The harness must distinguish Pi/provider retries from model-chosen lifecycle retries and distinguish valid canonical advancement from unsupported artifact repair.

## Observable behavior

1. A maintainer selects models, scenario, repetitions, budgets, and an output directory.
2. Every trial starts from byte-identical fixture content in an isolated disposable workspace and a fresh session.
3. The harness submits a fixed pre-approval prompt, waits for `agent_settled`, then submits exactly `Approved` only when the readiness precondition is met.
4. Event capture records prompts, turns, tool calls/results, usage, timings, and final canonical/filesystem state without injecting continuation messages.
5. A deterministic scorer reports whether execution began, contract order, actual verification commands, evidence validity, completion retries, forbidden post-approval mutations, blocker behavior, and final reconciliation.
6. Aggregate output groups results by exact provider/model/thinking level, Pi/Gentic revision, scenario, and fixture hash.

## Constraints

- Use the installed `@earendil-works/pi-coding-agent` SDK and the repository-pinned Pi 0.84.2 API; do not scrape TUI output.
- Use `SessionManager.create` with a trial-specific directory and `AgentSession` event subscriptions; `agent_settled`, not `agent_end`, is the run boundary.
- Disable compaction and provider auto-retry for scored baseline trials so retries are attributable; record any transport/provider failure separately as infrastructure failure.
- Load an explicit resource profile. The isolated profile loads only the pinned Pi-SWE extension/skills and fixed context; the fidelity profile records and loads the normal Gentic resources.
- Execute only in copied disposable repositories. Host path checks are guardrails, not a sandbox; live qualification requires an explicit container or equivalent sandbox acknowledgement.
- Never copy credentials into fixtures or result bundles. Use the existing agent credential store in place and redact secrets from captured content.
- Preserve raw traces outside Git by default. Durable initiative reports contain bounded summaries and links/digests, not full transcripts.
- Pin exact prompts, fixture bytes, tool allowlist, model selector, thinking level, and package/git revisions in every trial manifest.

## Non-goals

- Ranking general coding quality across unrelated repositories.
- Replacing Pi-SWE's deterministic unit tests.
- Automatically changing Pi-SWE policy based on benchmark results.
- Running unbounded autonomous workloads, concurrent mutating trials, or production repositories.
- Treating model self-reported test claims as command evidence.

## Acceptance criteria

- AC-01: Repeating a trial creates byte-identical starting workspaces and distinct fresh session IDs.
- AC-02: Captured events can prove whether any continuation was harness-injected and count model/tool/provider retries separately.
- AC-03: The scorer reconstructs exact executable-contract completion order and validates evidence hashes/envelopes against canonical state.
- AC-04: The scorer identifies actual verification commands and exit status rather than trusting report prose.
- AC-05: Mutations to immutable approved spec, plan, or contract files are reported as critical violations; expected mutable manifest/index fields are allowlisted structurally.
- AC-06: Clean-path, malformed-metadata, failing-verifier, and dependency-blocked scenarios have deterministic expected outcomes.
- AC-07: Aggregate reports include per-model success rate, Wilson interval, retry distribution, critical-violation count, infrastructure-failure count, token/cost/time totals, and raw-run digests.
- AC-08: Unit/integration tests use a fake agent/event stream; one opt-in authenticated smoke command exercises a real model without entering the default test suite.
- AC-09: A qualification run requires at least 20 valid trials per model/scenario; promotion requires at least 90% clean-path success with zero critical policy violations, while infrastructure failures are excluded and reported separately.
- AC-10: Documentation explains exact commands, isolation, budgets, result interpretation, and how to reproduce a run.

## Compatibility

Support Node.js `>=22.19.0` and the repository-pinned Pi packages. Fail closed with a clear version diagnostic when required SDK events or extension tools are unavailable. Persist a schema version in fixture, trial, event, score, and aggregate records.

## Migration and rollback

This is additive. No existing Pi-SWE artifact schema or Marathon database is migrated. Rollback removes the evaluation directory, package script, and tests; generated run state remains outside the repository unless explicitly retained.

## Risks

- Live agents can execute arbitrary shell behavior without an OS sandbox.
- Provider nondeterminism and changing model aliases can invalidate comparisons.
- Full transcripts may contain sensitive repository or environment content.
- Generated evidence can look valid while tests were never executed unless event correlation is enforced.
- The evaluator can accidentally measure global harness guidance instead of Pi-SWE unless resource profiles are explicit.
- Cost and wall time grow with models × scenarios × repetitions.

## Open blockers

None for planning. Live qualification requires authenticated models, cost approval, and sandbox availability at execution time.

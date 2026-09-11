# Cross-cutting finding: security, operations, and compatibility

- Topic: `pi-swe-model-evaluation`
- Assessed spec: r1, `.model-artifacts/initiatives/pi-swe-model-evaluation/specs/2026-09-11_1213-initiative-spec-r1.md`, `sha256:49d542a07588b2b471c6afc7bfc14804d855192e287fee80f8f1d242524322b7`
- Assessed plan: r1, `.model-artifacts/initiatives/pi-swe-model-evaluation/plans/2026-09-11_1213-plan-index-r1.md`, `sha256:2fa6c22b0e1dac7f4b90114237b3393b37069e3c05baa3a0a9ade20ac80f07aa`
- Decision: accept after incorporation into r2

## Security

- A Pi agent with `bash` is not sandboxed by path-policy regexes. Live smoke and qualification must require a copied disposable workspace plus explicit container/equivalent sandbox acknowledgement.
- The evaluator may reference the existing agent credential store but must never copy credentials into fixtures, sessions, or reports.
- Capture structured event metadata by default; redact environment values, authorization material, and bounded tool payloads before durable reports. Raw traces stay outside Git and receive owner-only permissions where supported.
- Cleanup is restricted to an evaluator-created realpath beneath its run root. Symlinks and path traversal fail closed.
- `swe_complete` and canonical mutations remain real extension behavior inside the copied fixture; the evaluator must not grant host-repository paths.

## Operations

- Record exact provider/model ID, thinking level, Pi/Gentic git/package versions, resource profile, prompt/fixture hashes, start/end time, token usage, cost, and infrastructure failures.
- Disable automatic provider retry for scored baseline. Provider failures may be rerun as new trial IDs but never silently replace a scored trial.
- Enforce per-trial wall time and aggregate model-call, token, cost, and trial ceilings. Default to sequential mutation; cap cross-workspace concurrency explicitly.
- `agent_settled` is the terminal observation point. Capture `queue_update`, `auto_retry_*`, and all tool events to prove continuation provenance.
- Retain raw run digests and bounded summaries; do not put bulky transcripts in committed model artifacts.

## Compatibility

- Compile against repository-pinned `@earendil-works/pi-*` 0.84.2, not global package paths. Validate required SDK exports/events and the `swe_complete` tool at dry run.
- Store exact, immutable provider/model IDs; aliases are display metadata only.
- Version fixture, event, trial, score, and aggregate schemas independently and reject unknown future versions.
- Resource profiles must enumerate loaded extension/skill/context identities so a changed global environment cannot masquerade as the same experiment.
- Keep live tests opt-in because authentication, available models, and provider event details vary.

## Required r2 changes

Make sandbox acknowledgement, resource manifests, retry classification, budgets, redaction, compatibility preflight, and external raw-trace storage explicit acceptance requirements in the runner and CLI contracts.

## Residual risks

Provider nondeterminism cannot be eliminated; confidence intervals and repeated exact identities quantify it. Regex/path guardrails remain insufficient without OS isolation.

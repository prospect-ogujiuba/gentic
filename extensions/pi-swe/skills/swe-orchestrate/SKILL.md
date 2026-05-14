---
name: swe-orchestrate
description: Sequence existing pi-swe lifecycle skills from work orders, todos when available, and durable model artifacts without adding coupling or hidden autonomous execution.
---

# SWE Orchestrate

Use this when a SWE flow needs a next-stage recommendation, resume decision, or deterministic handoff across existing `pi-swe` stages.

## Workflow

1. **Inspect work order** — read the assigned work order, active todo when available, and stable model artifacts before relying on chat memory.
2. **Choose the next lifecycle stage** — classify the path as feature, bug, DSA-sensitive, resume, finalize-gated, or blocked.
3. **Follow the matching existing skill** — use `swe-plan`, `swe-diagnose`, `swe-tdd`, `swe-dsa`, `swe-implement`, `swe-verify`, `swe-review`, or `swe-finalize`; do not duplicate their detailed instructions here.
4. **Require verification evidence** — route to `swe-verify` before review or finalization when evidence is missing.
5. **Use `swe-finalize` as terminal handoff** — finalize only when required implementation, verification, and review inputs exist.
6. **Emit an exception handoff** — when blocked, stop hidden work and report the blocked case, relevant artifact path, and next human decision.

## Artifact contract

Prefer durable model artifacts as the cross-session contract:

- `.model-artifacts/specs/<topic>/...` for work orders and slice contracts.
- `.model-artifacts/plans/<topic>/...` for orchestration plans.
- `.model-artifacts/logs/<topic>/...` for state/resume trails and implementation evidence.
- `.model-artifacts/findings/<topic>/...` for diagnosis, DSA, or review findings.
- `.model-artifacts/reports/<topic>/...` for verification, final handoff, and exception reports.

Optional tools such as todo or git evidence may enrich context when visible to the agent, but orchestration must still work without them and must not depend on peer extension internals.

## Report format

- Current artifact readiness.
- Next recommended lifecycle step.
- Required read paths and write artifact path.
- Gate status for verification, review, and finalize.
- Exception handoff, if blocked.

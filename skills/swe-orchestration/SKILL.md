---
name: swe-orchestration
description: Operate or resume a durable pi-swe workflow through /swe with fenced multi-agent lifecycle gates, recovery, clarification, protected verification, and final acceptance. Use when the user asks to run, inspect, recover, or explain native SWE orchestration.
---

# SWE Orchestration

Use this skill for operator-driven `/swe` orchestration. Do not manually edit `workflow.json`; it is lifecycle authority and must be mutated only by the installed pi-swe surfaces.

## Inputs

Determine:

- repository and workflow topic;
- requested action: start, resume, inspect, recover, pause, or stop;
- any explicit authorization for manual decisions or external side effects.

If the topic is ambiguous, ask once. Never infer authorization to commit, push, deploy, release, self-upgrade, or activate a staged runtime.

## Workflow

1. **Check runtime readiness.** Confirm the installed entrypoint registers native v2 orchestration and integrity hooks. If it still registers only `registerSweCommand` and `registerSweWorkflowTool`, report that production remains on v1 and do not simulate, hot-load, or partially activate v2.
2. **Inspect before mutation.** Ask the operator to run `/swe work inspect <topic>` (or use the read-only tool action when available). Identify stage, owner, active lease, pending clarification, remediation budget, workspace receipt, and next legal action.
3. **Start or resume once.** The operator runs `/swe work start <topic>` for untouched work or `/swe work resume <topic>` for paused/recovered work. Never start a second parent or bypass active pi-todo ownership.
4. **Follow the engine handoff.** Let the native engine perform plan review, scoped implementation, fresh general review, selected concern review, safe integration, protected checks, task completion, and final initiative acceptance. Do not replace a child role with parent implementation.
5. **Handle questions durably.** Surface each stable question ID. The operator answers with `/swe work answer <topic> [question-id]`; do not invent an answer. Resume the same stage after the answer is recorded.
6. **Inspect without attaching.** Use `/swe work inspect <topic>` for durable state and `/swe work runs <topic>` for bounded tails. Native children are non-PTY processes, so interactive-shell `/attach` does not apply.
7. **Recover explicitly.** Use pause/stop before interruption. After restart, inspect first, then resume so orphaned or expired leases are fenced and a fresh parent checkpoint is established. Use retry only for recoverable blocked work.
8. **Respect remediation limits.** Reviewer disagreement, inadequate tests, failed or source-changing checks, and snapshot drift enter cumulative remediation. If budget is exhausted, require the operator's keyboard-confirmed `/swe work reset <topic>` decision.
9. **Record manual validation.** When requested by the workflow, the operator uses `/swe work validate <topic> <approve|reject>`. Manual validation never substitutes for fresh final acceptance.
10. **Finish only through final acceptance.** Task-local evidence, historical completion, UI actions, or a direct tool `complete` must not complete a managed initiative. Report completion as implementation acceptance only.

## Success criteria

- Every stage advances through the same command/tool/engine ownership and mutation gates.
- Current protected checks pass against the unchanged whole-source snapshot.
- Required manual decisions have explicit actor, rationale, and timestamp.
- Final independent acceptance is current and the workflow is durably complete.
- Runtime output is bounded; accepted reports, findings, receipts, answers, and recovery history remain in `workflow.json`.
- No external side effect occurs without separate explicit authorization.

See [operator commands and recovery](references/operator-guide.md) for the command sequence and current rollout caveat.

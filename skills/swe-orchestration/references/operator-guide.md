# pi-swe operator guide

## Current Gentic rollout state

Implementation completion and production activation are separate. Check `extensions/pi-swe/index.ts` before use:

- If it registers only `registerSweCommand` and `registerSweWorkflowTool`, v1 remains the installed production runtime. Native v2 `OrchestrationEngine`, parent-integrity hooks, runner, and workspace manager are fixture-tested but not registered. Do not use hot reload, direct imports, or self-upgrade to activate part of v2.
- Native multi-agent execution is ready only after a separately authorized rollout registers the complete v2 runtime as one reviewed unit.

The v1 `/swe` status, migration, and durable workflow controls remain usable. Do not claim that v2 children are running when only the v1 entrypoint is installed.

## Native v2 command sequence

Once the complete v2 runtime is registered:

```text
/swe work inspect <topic>
/swe work start <topic>       # new workflow execution
/swe work resume <topic>      # paused, blocked, or recovered execution
/swe work inspect <topic>     # durable stage and recovery state
/swe work runs <topic>        # bounded child report/output tails
```

During execution:

```text
/swe work answer <topic> [question-id]
/swe work validate <topic> <approve|reject>
/swe work pause <topic>
/swe work stop <topic>
/swe work retry <topic>
/swe work reset <topic>
```

`pause` interrupts active children and preserves state. `stop` cancels the active child and preserves durable evidence; it is not deletion. `retry` resumes recoverable blocked work. `reset` requires a reason and keyboard confirmation because it extends the remediation budget.

## What the operator should expect

1. Fresh plan review approves or rejects the full contract.
2. A scoped implementer works in an isolated retained Git workspace.
3. A distinct general reviewer judges the cumulative delta without the implementer's conversation or verdict.
4. One composed concern reviewer runs only for selected specialist concerns.
5. Approved output is integrated without staging, stashing, resetting, committing, or pushing.
6. Exact planned checks run through protected `bash` against the same source snapshot.
7. Failures or source changes create cumulative remediation and complete re-review.
8. After all tasks, initiative checks and a fresh final reviewer gate overall completion.

Fresh process context limits conversation leakage but does not guarantee independent judgment from the same model/provider family. Workflow controls protect lifecycle and evidence integrity; they are not an OS sandbox.

## Inspection and recovery

Native children are non-PTY processes and are not interactive-shell sessions. `/attach` therefore cannot connect to them. Use `inspect` and `runs`.

After a crash or parent restart:

1. Run `/swe work inspect <topic>`.
2. Review orphan/expired lease, prepared integration, unanswered clarification, and interrupted-acceptance notices.
3. Run `/swe work resume <topic>` once.
4. Rerun any checks invalidated by the new parent/session/snapshot checkpoint.

Never dismiss workflow evidence to recover. Dismissing an exited runtime entry removes only its bounded in-memory tail; accepted reports and receipts remain durable.

## Canonical post-cutover authority repair

Only the controlling `swe-production-rollout` may use:

```text
/swe work adopt-post-cutover swe-production-rollout
```

The command fails closed unless the workflow is the exact canonical rev41 contract and settled output-limit plan-review blocker, every task is residue-free, and the control checkout differs only by the exact unstaged authority file. Provenance separates the historical task range (rollout anchor → post-Session9 `2c8fb31…`) from the fixed-scope authority-repair range (`2c8fb31…` → repair `HEAD`); the retained report truthfully remains pinned to `08a434f…`. It creates a disposable checkout, performs a lockfile-driven dependency install, gathers fresh independent reviews, and executes exact task checks through one-shot parent/session/runtime- and snapshot-bound grants. Any blocking-finding dispositions are entered first so the displayed stable evidence hash binds them; authorization JSON then supplies `id`, `authorizedBy`, `authorizedAt`, that `evidenceHash`, and `rationale`. A second keyboard/RPC confirmation is mandatory. `pi -p` and `swe_workflow` model calls cannot adopt. Successful adoption is one atomic history-preserving transition: tasks 1–16 become historical and only `cutover-release-qualification` remains pending.

## Authorization boundary

Workflow completion authorizes none of the following: commit, push, pull-request creation, deployment, release, production rollout, self-upgrade, or cleanup/discard of retained workspaces. Request each side effect separately.

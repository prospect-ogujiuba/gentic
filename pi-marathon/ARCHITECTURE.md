# Pi Marathon Architecture

## Design objective

Pi Marathon is designed for long-running software-delivery objectives where a single conversational context is too fragile. It separates durable orchestration state from ephemeral model context and refuses to equate a worker's claim of completion with verified completion.

The central invariant is:

> The database and workspace checkpoints are authoritative. Model conversation history is supporting evidence, not system state.

## Component map

```text
Pi interactive session
  ├─ /marathon command
  ├─ marathon_control tool
  └─ status widget / persistent entries
            │
            │ authenticated loopback HTTP
            ▼
Project daemon (detached Node process)
  ├─ control API
  ├─ scheduler
  ├─ run/task state machines
  ├─ budget enforcement
  ├─ process cancellation
  └─ recovery
       │              │
       │              ├──────────────► isolated workspace
       │              │                  ├─ Git worktree, or
       │              │                  └─ copied private Git snapshot
       │              │
       ▼              ▼
SQLite ledger     Pi SDK sessions
  ├─ runs          ├─ planner
  ├─ tasks         ├─ worker
  ├─ dependencies  ├─ verifier
  ├─ attempts      ├─ critic
  ├─ events        └─ auditor
  ├─ steering
  └─ checkpoints
```

## Process boundary

The Pi extension is a control surface, not the runtime owner. On the first command that needs the service, it launches `pi-marathond` as a detached child process and writes stdout/stderr to the project daemon log.

The extension passes resolved URLs for the Pi SDK and TypeBox modules to the child when available. This matters because the daemon is a plain Node process rather than a child Pi interactive session.

The daemon:

- binds only to `127.0.0.1`;
- chooses an ephemeral TCP port;
- generates a random bearer token;
- writes a permission-restricted `daemon.json` discovery record;
- maintains a PID lock per canonical project path;
- updates a heartbeat every ten seconds;
- owns the SQLite connection and all active run/session controllers.

Normal control commands call `MarathonClient.ensure()`. If the old process is missing, stale discovery files are removed, a new daemon is launched, and recovery runs before scheduling resumes.

## State machines

### Run statuses

```text
queued
  -> planning
  -> running
       ├─ paused
       ├─ waiting_for_human
       ├─ completed
       ├─ failed
       └─ cancelled
```

Run phases provide finer-grained state:

```text
created -> workspace -> planning -> execution -> final_audit -> complete
```

`paused` and `waiting_for_human` are resumable. `completed`, `failed`, and `cancelled` are terminal.

### Task statuses

```text
pending -> running -> verifying -> passed
                   └────────────-> pending   (bounded retry)
                   └────────────-> failed
pending ------------------------------------> blocked
pending/running/verifying ------------------> cancelled
```

A task is ready only when all dependency tasks are `passed`. A failed, blocked, or cancelled dependency propagates `blocked` to downstream pending tasks.

## Planning and graph invariants

The planner receives the original objective, workspace metadata, and queued steering. It cannot edit files. It must return typed tasks containing:

- a stable key;
- type and priority;
- description;
- dependencies by key;
- exact acceptance criteria;
- task-specific verification commands;
- optional attempt limit.

Normalization:

- canonicalizes keys;
- deduplicates strings;
- clamps counts and numeric values;
- rejects duplicate keys;
- rejects unknown dependencies;
- removes self-dependencies;
- performs depth-first cycle detection;
- caps the graph at planner and run task budgets.

Tasks and dependency edges are inserted transactionally.

## Scheduler

The scheduler polls at the lowest configured `pollIntervalMs` among executable runs.

Concurrency rules are deliberately conservative:

- read-only `research` and `review` tasks may execute concurrently;
- no read-only task starts while that run has a writer active;
- implementation, test, and documentation tasks are serialized within a run;
- active task jobs are counted globally inside the project daemon when each run applies its configured ceiling;
- planning and final-audit jobs are separate from task worker slots.

Each claimed task receives a lease. The daemon periodically renews it. On restart, any task left in `running` or `verifying` is reset to `pending`, while its active attempt is marked `aborted`.

## Role sessions

Each attempt creates a fresh Pi SDK session under:

```text
sessions/<run-id>/<role>/<attempt-id>
```

The resource loader disables unrelated extensions, skills, prompt templates, and themes for worker sessions. A small in-process safety extension intercepts tool calls and enforces role and path policy.

Every role receives a typed terminating completion tool:

- `finish_plan`
- `finish_task`
- `finish_verification`
- `finish_critique`
- `finish_audit`

The completion tool captures structured output and terminates the role session. A JSON fallback exists for model/provider edge cases, but typed tool completion is the expected path.

### Context regeneration

Workers do not inherit an ever-growing primary conversation. Their prompt is regenerated from durable records:

```text
original objective
assigned task
exact acceptance criteria
completed dependency records
prior attempts and failures
retry guidance
queued steering
workspace metadata
```

This bounds context size and preserves important failure history across process restarts.

## Verification pipeline

For each worker completion:

1. Store the worker's structured report.
2. Run configured global and task-specific deterministic commands.
3. Stop deterministic execution at the first block, timeout, or non-zero exit.
4. Launch a fresh read-only verifier when agent verdicts are enabled.
5. Require an explicit acceptance entry for every exact criterion.
6. Reject a nominal pass if any criterion lacks positive evidence.
7. Commit/checkpoint only after the combined verdict passes.

The final audit operates against the original objective rather than merely checking that all task rows say `passed`. It receives the task ledger, workspace diff/description, and final deterministic command results.

On final-audit failure, typed repair tasks can be appended while task and audit budgets remain. The audit repeats until it passes or the maximum audit count is reached.

## Failure intelligence

A normal failure produces retry guidance from the verifier or the caught runtime error. After `criticAfterFailures` consecutive failures, a read-only critic receives the attempt ledger and must provide:

- a root-cause diagnosis;
- failed assumptions;
- a materially different strategy;
- concrete next actions.

The resulting strategy becomes durable retry guidance for the next fresh worker.

## Workspace strategy

### Auto mode

- Clean Git repository: create a linked worktree and a `marathon/<run-id>` branch from the captured base commit.
- No usable Git repository: create an isolated copy.

### Worktree mode

The source repository must have a valid `HEAD`; it must also be clean when `requireCleanGit` is true. Work happens in a linked worktree outside the source checkout. Accepted tasks are committed on the Marathon branch.

### Copy mode

The source tree is copied while excluding common generated directories and all `.git` directories. When Git is available, Marathon initializes a private repository inside the copy and creates an initial snapshot commit. Subsequent accepted tasks become commits there.

If Git initialization is unavailable, checkpoints use a SHA-256 content-tree digest. This proves a state identity but does not provide rollback commits.

### Direct mode

The original directory is used as the workspace. It is intentionally not the default.

## Checkpoints

For Git-backed workspaces, checkpointing records:

- the pre-checkpoint porcelain status;
- a commit using a local synthetic identity when changes exist and auto-commit is enabled;
- the resulting `HEAD` object ID.

For non-Git fallback workspaces, checkpointing hashes directory entries, symlink targets, paths, sizes, and file bytes in lexical order.

The checkpoint row records the run, optional task, ref/digest, summary, metadata, and creation time. The event ledger separately records checkpoint creation.

## Budget accounting

Budget checks run before every model attempt and during scheduler ticks.

An attempt transaction increments `runs.agent_calls` before the provider call begins. This means failed and aborted calls count, and concurrent starts cannot all observe the same unreserved call slot in the single daemon process.

Observed cost is added after Pi returns usage. Because actual provider cost is unknown in advance, `maxCostUsd` is an observed-cost stop rather than a strict prepaid reservation.

Wall time is measured from `started_at`, not accumulated CPU time. Reaching a budget changes the run to `paused`, aborts active work, and preserves all state.

## Cancellation

Every run job and task job has an `AbortController`. Pause, cancel, daemon shutdown, task timeout, or run budget exhaustion aborts the relevant session.

External verification commands are spawned in their own process group on non-Windows systems. Termination sends `SIGTERM`, waits briefly, then sends `SIGKILL` if necessary. Windows uses child termination without Unix process groups.

## Database

The database uses Node's built-in SQLite driver with:

```text
journal_mode = WAL
foreign_keys = ON
busy_timeout = 5000
```

Core tables:

- `runs`: objective, status, phase, config snapshot, workspace, budget usage, summary, errors.
- `tasks`: normalized task definitions, status, leases, attempts, result, failure guidance.
- `task_dependencies`: DAG edges.
- `attempts`: role calls, session path, normalized output, usage, errors, timing.
- `events`: append-only operational ledger.
- `steering`: pending/applied human guidance.
- `checkpoints`: Git refs or content digests and evidence.

Deleting a run cascades to its graph, attempts, events, steering, and checkpoints, although this release does not expose a delete command.

## Control API

Authenticated routes include:

```text
GET  /v1/runs
POST /v1/runs
GET  /v1/active
GET  /v1/doctor
GET  /v1/runs/:id
GET  /v1/runs/:id/events
POST /v1/runs/:id/pause
POST /v1/runs/:id/resume
POST /v1/runs/:id/cancel
POST /v1/runs/:id/steer
POST /v1/runs/:id/budget
POST /v1/shutdown
```

Request bodies are capped at 1 MiB. Run goals are capped at 50,000 characters. Control responses disable caching and include `nosniff` headers.

## Security boundary

The command and path policy is deliberately a guardrail, not a sandbox. It catches common dangerous actions and accidental host mutations, but an unrestricted shell or language interpreter can encode equivalent operations in many ways.

The trusted production deployment pattern is:

```text
host
  -> container / VM / policy sandbox
       -> Pi
            -> Pi Marathon extension and daemon
                 -> isolated worktree/copy
```

The daemon is detached from Pi but remains inside the same OS security boundary as the Pi process.

## Extension points

Natural next additions are:

- a remote queue and multiple worker hosts;
- container-per-attempt execution;
- GitHub/GitLab pull-request publication after explicit approval;
- artifact manifests and binary build retention;
- richer cost reservation using provider-specific price metadata;
- task-level rollback to the prior verified commit before retry;
- policy engines such as OPA instead of regular-expression command gates;
- OpenTelemetry traces and metrics;
- signed checkpoint attestations;
- a web dashboard consuming the local control API.

These are intentionally outside the 0.1.0 local-first core.

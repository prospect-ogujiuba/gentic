# Pi Marathon

A durable, restartable, verifier-driven agent runtime for [Pi](https://github.com/earendil-works/pi).

Pi Marathon turns a large repository objective into a dependency graph, executes the graph through role-separated Pi sessions, independently verifies every task, checkpoints accepted work, performs a whole-project audit, and creates repair tasks until the objective passes or a configured limit is reached.

It is intentionally not a single endless chat loop. Conversation context is disposable; SQLite state, task evidence, sessions, and workspace checkpoints are the source of truth.

## What it provides

- A detached local daemon that continues after the interactive Pi terminal closes.
- Durable SQLite state for runs, tasks, dependencies, attempts, events, steering, usage, and checkpoints.
- Automatic recovery after daemon failure or restart.
- Isolated Git worktrees for clean Git repositories.
- Isolated copies with a private Git snapshot repository for non-Git projects or explicit copy mode.
- Planner, worker, verifier, critic, and final-auditor roles, each using a fresh Pi session.
- Dependency-aware scheduling with parallel read-only research/review tasks and serialized writers per run.
- Deterministic build, test, lint, and type-check commands plus an independent model verdict.
- Retry guidance informed by an explicit critic after repeated failures.
- Final-audit repair cycles for recursive completion.
- Agent-call, task-count, wall-clock, cost, attempt, timeout, and audit-cycle limits.
- Human escalation through `waiting_for_human`, steering, pause, and resume.
- A `/marathon` command, `marathon_control` model tool, TUI status widget, and standalone control CLI.
- No automatic merge, force-push, or modification of the user's current branch in the default workspace mode.

## Requirements

- Node.js 22.19.0 or newer.
- A current Pi installation and at least one authenticated model provider.
- Git is strongly recommended. Pi Marathon can run without Git, but Git enables recoverable commits and useful change inspection.

The package is built against `@earendil-works/pi-coding-agent` 0.84.4 and uses only Pi core peer dependencies plus Node's built-in SQLite module.

## Install from this source package

```bash
unzip pi-marathon-0.1.0.zip
cd pi-marathon
npm install --ignore-scripts
npm run build
pi install "$(pwd)"
```

Pi local-path packages are referenced in place, so keep this directory after installation. Restart Pi or use `/reload` after rebuilding the extension.

To try it without permanently adding it to Pi settings:

```bash
pi -e ./dist/extension/index.js
```

## First run

Open Pi from the repository you want Marathon to work on:

```bash
cd /path/to/project
pi
```

Validate the environment:

```text
/marathon doctor
```

Start a substantial objective:

```text
/marathon Build the production-ready application defined in SPEC.md. Implement it, test it, document it, and do not finish until the integrated acceptance criteria pass.
```

The default flow is:

```text
objective
  -> isolated workspace
  -> planner task DAG
  -> workers
  -> deterministic checks
  -> independent verifiers
  -> checkpoints
  -> whole-project audit
  -> repair tasks when needed
  -> completed / waiting_for_human / failed
```

## Commands

```text
/marathon <goal>                 Start a durable run
/marathon start <goal>           Start a durable run
/marathon status [run-id]        Show status and progress
/marathon list                   List recent runs
/marathon tasks [run-id]         Show task graph state
/marathon inspect [run-id]       Show detailed state and recent events
/marathon failures [run-id]      Show failure diagnostics
/marathon events [run-id]        Show the durable event ledger
/marathon pause [run-id]         Pause and abort active sessions safely
/marathon resume [run-id]        Resume a paused or blocked run
/marathon cancel [run-id]        Cancel a run; stop is an alias
/marathon steer [run-id] <text>  Add guidance for the next worker
/marathon budget [run-id] calls=160 minutes=900 cost=25 tasks=80 audits=4
/marathon doctor                 Check Node, Git, SQLite, and model access
/marathon path                   Show the state database and daemon log path
/marathon shutdown               Stop this project's daemon
```

The same interface is available outside Pi:

```bash
pi-marathonctl status
pi-marathonctl tasks
pi-marathonctl steer "Prioritize the API contract and preserve backward compatibility"
pi-marathonctl pause
pi-marathonctl resume
```

Run the CLI from the same project directory so it resolves the correct per-project daemon and database.

## Where the result goes

### Git repository, default `auto` mode

Marathon requires a clean source repository by default, then creates:

- a branch named `marathon/<run-id>`;
- a linked worktree under the per-project Marathon state directory;
- a verified commit after each accepted task when `git.commitPassedTasks` is enabled.

Your checked-out branch is left alone. The completed run reports the exact worktree and branch. Review before integrating:

```bash
git log --oneline --decorate main..marathon/<run-id>
git diff main...marathon/<run-id>
git merge --no-ff marathon/<run-id>
```

Replace `main` with the branch from which the run began. Marathon never merges or pushes automatically.

### Non-Git project or `copy` mode

Marathon copies the source into its state directory, excludes common generated directories, initializes a private Git repository inside the copy when Git is available, and commits an initial snapshot. This gives task-level checkpoints while leaving the original directory unchanged.

Copy-mode output is not connected to the original repository. Review the reported workspace and transfer the accepted changes manually.

### `direct` mode

Direct mode runs inside the original working tree. It exists for controlled environments, but it removes the default isolation boundary and may create commits on the current branch. Use it only when that is explicitly desirable.

## Configuration

Configuration is merged in this order:

1. built-in defaults;
2. `~/.pi/agent/marathon/config.json`;
3. `<project>/.pi/marathon.json`;
4. per-run overrides sent through the daemon API.

A balanced project configuration:

```json
{
  "scheduler": {
    "pollIntervalMs": 750,
    "maxConcurrency": 2,
    "maxResearchConcurrency": 2,
    "leaseSeconds": 180
  },
  "budget": {
    "maxTasks": 60,
    "maxAgentCalls": 120,
    "maxRunMinutes": 720,
    "maxCostUsd": null,
    "maxFinalAuditCycles": 3
  },
  "task": {
    "maxAttempts": 3,
    "timeoutMinutes": 45,
    "criticAfterFailures": 2
  },
  "planner": {
    "maxTasks": 30
  },
  "verification": {
    "commands": [],
    "commandTimeoutMs": 600000,
    "requireAgentVerdict": true
  },
  "workspace": {
    "mode": "auto",
    "requireCleanGit": true,
    "keepOnComplete": true
  },
  "git": {
    "commitPassedTasks": true,
    "branchPrefix": "marathon/"
  },
  "models": {
    "planner": { "thinking": "high" },
    "worker": { "thinking": "high" },
    "verifier": { "thinking": "high" },
    "critic": { "thinking": "high" },
    "auditor": { "thinking": "high" }
  },
  "safety": {
    "allowNetwork": true,
    "allowedExternalPaths": []
  }
}
```

A complete sample is in `examples/marathon.json`; a stricter offline profile is in `examples/marathon.hardened.json`.

### Model selection

Each role can use the current Pi model or an explicit Pi model selector:

```json
{
  "models": {
    "planner": { "model": "provider/model-id", "thinking": "high" },
    "worker": { "model": "provider/model-id", "thinking": "high" },
    "verifier": { "model": "provider/model-id", "thinking": "xhigh" },
    "critic": { "model": "provider/model-id", "thinking": "high" },
    "auditor": { "model": "provider/model-id", "thinking": "xhigh" }
  }
}
```

Leaving `model` unset lets Pi resolve its normal configured/default model. `marathon doctor` reports the model catalog visible to the daemon.

### Verification commands

Global commands run for every task in addition to task-specific commands produced by the planner:

```json
{
  "verification": {
    "commands": [
      "npm run typecheck",
      "npm test"
    ],
    "commandTimeoutMs": 900000,
    "requireAgentVerdict": true
  }
}
```

Commands stop at the first blocked, timed-out, or non-zero result. A task passes only when deterministic commands pass and the verifier maps positive evidence to every exact acceptance criterion.

When no final-audit commands are configured, Marathon detects conventional project checks such as npm scripts, `go test ./...`, `cargo test`, `pytest`, Maven, Gradle, and `make test`.

### Budget changes during a run

```text
/marathon budget calls=200 minutes=1440 cost=40 tasks=100 audits=5
```

- Agent calls are reserved when an attempt starts, so failed provider calls also count.
- Observed provider cost is added after a response supplies usage data.
- A cost cap is therefore a stop condition based on reported cost, not a prepaid transaction guarantee; concurrent calls can cause a small overshoot.
- Reaching a budget pauses the run rather than deleting work. Raise the relevant limit and resume.

## Durable state and recovery

State is stored per canonical project path under:

```text
~/.pi/agent/marathon/projects/<project-hash>/
  marathon.db
  daemon.json
  daemon.lock
  daemon.log
  sessions/<run-id>/<role>/
  workspaces/<run-id>/
```

`daemon.json`, the lock file, and state directory are created with restrictive local permissions where the operating system supports them. The HTTP service binds to `127.0.0.1` on an ephemeral port and authenticates control requests with a random bearer token.

When the daemon restarts, attempts left in `running` become `aborted`, leased tasks return to `pending`, existing workspace changes remain available, and scheduling continues from the database. Any normal control command can restart a missing daemon automatically.

Machine reboot recovery is command-triggered: open Pi in the project and run `/marathon status` or `/marathon resume`.

## How role separation works

- **Planner:** read-only repository inspection; emits a finite acyclic task graph.
- **Worker:** receives exactly one task plus dependency results, prior attempt evidence, steering, and acceptance criteria.
- **Verifier:** read-only and independent; distrusts the worker report and proves each criterion from the actual workspace.
- **Critic:** invoked after repeated failures to produce a materially different strategy.
- **Auditor:** checks the original objective against the integrated result and may create bounded repair tasks.

Every role must finish through a typed completion tool. Outputs are normalized, graph dependencies are checked, cycles and unknown dependencies are rejected, and raw chat history is not relied upon for recovery.

## Safety model

Pi Marathon adds defense-in-depth controls:

- isolated workspaces by default;
- role-based read-only versus write capabilities;
- path checks for read/write tools;
- protected `.git`, `.env*`, and `node_modules` writes;
- configurable blocked shell-command patterns;
- rejection of obvious absolute-path mutations outside the workspace;
- optional network-command blocking;
- process-group termination on timeout or cancellation;
- no automatic push, merge, or force operation.

These checks are **not an operating-system sandbox**. Shells and language runtimes can express mutations in ways that no regular-expression policy can completely detect. Pi extensions also execute with the permissions of the Pi process. For unattended work on untrusted repositories, run the entire Pi process inside Docker, Gondolin, OpenShell, or another real sandbox. See `SECURITY.md`.

## Development and tests

```bash
npm install --ignore-scripts
npm run check
npm test
```

The test suite covers:

- task-graph normalization and cycle rejection;
- command/path policy decisions;
- SQLite persistence and stale-work recovery;
- counting failed attempts against the call budget;
- isolated Git worktrees and checkpoints;
- private snapshot repositories for copy mode;
- end-to-end planner/worker/verifier/auditor engine behavior with a deterministic fake runner;
- local daemon binding and bearer-token protection.

## Current boundaries

- This release is a strong local-first starter, not a distributed queue. One daemon owns a project's SQLite database.
- It does not auto-merge, open pull requests, push branches, or deploy anything.
- The policy layer is not a substitute for container or VM isolation.
- The detached process survives terminal closure, but not a machine reboot; a later command restarts it.
- Windows code paths are present, but the included integration tests were executed in a Linux environment.
- Provider-specific billing data is only as complete as the usage objects returned through Pi.

See `ARCHITECTURE.md` for implementation details and extension points.

# Changelog

## 0.1.0 — 2026-09-01

Initial local-first release.

### Added

- Pi extension with `/marathon`, `marathon_control`, persistent status entries, and TUI status/widget integration.
- Detached per-project daemon with authenticated loopback API, PID locking, heartbeat, and automatic restart.
- SQLite WAL persistence for runs, DAG tasks, dependencies, attempts, events, steering, checkpoints, and usage.
- Crash recovery for in-flight attempts and leased tasks.
- Git worktree isolation and private Git snapshot repositories for copied projects.
- Planner, worker, verifier, critic, and final-auditor Pi SDK sessions.
- Typed terminating completion tools and normalized structured output.
- Dependency-aware scheduling, parallel read-only tasks, and serialized writers.
- Deterministic verification, exact acceptance-criterion evidence, bounded retries, criticism, and final repair cycles.
- Task, call, time, cost, attempt, command-timeout, and audit limits.
- Command/path policy guardrails and process-group cancellation.
- Standalone `pi-marathonctl` and `pi-marathond` binaries.
- Nine automated tests covering graph, persistence, recovery, policy, workspaces, engine completion, and daemon authentication.

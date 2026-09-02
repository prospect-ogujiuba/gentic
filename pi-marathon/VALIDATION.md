# Validation Report

Validated on September 1, 2026.

## Results

- TypeScript strict compilation: passed.
- Clean JavaScript build to `dist/`: passed.
- Node test runner: 9 passed, 0 failed.
- Generated JavaScript syntax check: passed.
- Package manifest and example configuration JSON parsing: passed.

The automated suite covers:

1. Loopback daemon binding and bearer-token authentication.
2. End-to-end planning, execution, independent verification, checkpointing, final audit, and completion using a deterministic fake agent runner.
3. Task graph normalization, unknown-dependency rejection, and cycle rejection.
4. Destructive-command and out-of-workspace path-policy decisions.
5. SQLite persistence and recovery of interrupted work.
6. Reservation of agent-call budget for failed as well as successful attempts.
7. Isolated Git worktree creation and verified checkpoints.
8. Private snapshot repositories for non-Git/copy-mode projects while leaving the source untouched.

## Environment and limitation

The validation container used Node.js 22.16.0. The package itself requires Node.js 22.19.0 or newer to match the targeted Pi runtime. Node printed its expected experimental warning for the built-in SQLite module in the validation environment.

A live authenticated model-provider call and an interactive Pi TUI load were not executed in this container. Dependency installation from the public registry timed out, and no provider credentials were supplied. The integration layer was therefore type-checked against temporary declarations derived from the targeted Pi 0.84.4 interfaces, while runtime behavior below that boundary was exercised with deterministic test doubles.

Before production use, run the following in the actual Pi environment:

```bash
npm install --ignore-scripts
npm run check
npm test
pi install "$(pwd)"
```

Then open Pi in a disposable repository and run:

```text
/marathon doctor
/marathon Build and verify a small, reversible test change.
```

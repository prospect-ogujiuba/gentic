# Security

## Read this before unattended runs

Pi Marathon executes model-directed tools through Pi. It provides isolation-by-workspace and policy guardrails, but it is not an operating-system sandbox. The extension and detached daemon have the same effective user permissions as the Pi process.

For untrusted code, unknown dependencies, or high-value host credentials, run the entire Pi process and Marathon daemon inside a container, micro-VM, or policy-controlled sandbox.

## Default protections

- Worktree or copied workspace instead of the current checkout.
- Clean-source requirement for default Git worktrees.
- Read-only planner, verifier, critic, research, and review roles.
- Write-path checks restricted to the workspace or explicitly allowed roots.
- Direct writes to `.git`, `.env*`, and `node_modules` are blocked through Pi write/edit tools.
- Common destructive, privileged, power-management, disk-formatting, force-push, and pipe-to-shell commands are blocked.
- Network-capable commands can be disabled.
- Verification commands are subjected to the same command policy.
- Daemon API binds to loopback and requires a random bearer token for control routes.
- Token, lock, log, session, and database state live in a permission-restricted per-project directory.
- No automatic Git push, merge, deployment, or secret acquisition.

## What the policy cannot guarantee

A shell command can invoke Python, Node, Ruby, PowerShell, compiled programs, package scripts, or repository-provided binaries that perform arbitrary actions. Regular expressions cannot reliably determine the full effect of a program.

Symlinks, compiler plugins, test hooks, package-manager lifecycle behavior, malicious repositories, and compromised dependencies can also cross a naïve directory boundary unless the operating system enforces it.

`allowedExternalPaths` deliberately expands access and should remain empty unless a specific workflow requires it.

`workspace.mode=direct` removes the main filesystem safety property. It should not be used for unattended work on an important checkout.

## Recommended hardened profile

Start with `examples/marathon.hardened.json`, then run Pi inside a sandbox that exposes only:

- the target repository or a disposable clone;
- the minimum provider authentication required by Pi;
- no SSH agent unless Git access is required;
- no cloud credentials unless the run explicitly needs them;
- no browser profiles, password stores, home-directory secrets, or production kubeconfig;
- outbound network destinations restricted to the model provider and approved registries.

Keep `workspace.requireCleanGit=true` and `git.commitPassedTasks=true`.

## Secrets

Do not put secrets in the goal, steering messages, repository instructions, acceptance criteria, or test fixtures. These values are persisted in SQLite and may be included in model prompts and Pi session files.

Marathon asks roles not to inspect secret-bearing files and blocks direct `.env*` writes, but it does not claim to discover or redact every secret. Use short-lived, least-privilege credentials and a sandbox-level secret-injection mechanism.

## Reviewing output

Before merging a Marathon branch:

```bash
git log --stat main..marathon/<run-id>
git diff --check main...marathon/<run-id>
git diff main...marathon/<run-id>
```

Run your trusted CI pipeline independently. Do not treat model verification or local tests as a replacement for code review, dependency review, security scanning, or deployment approval.

## Incident response

To stop a project daemon:

```text
/marathon shutdown
```

To terminate a run while preserving evidence:

```text
/marathon cancel <run-id>
```

The state path and log are shown by:

```text
/marathon path
```

If a run behaved unexpectedly, preserve `marathon.db`, `daemon.log`, the run workspace, and Pi role sessions before cleanup. Revoke any credentials the workspace could access.

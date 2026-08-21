# Phase 4: Safety and deterministic tools

Created: 2026-08-21
Purpose: Resolve confirmed safety defects and align mutating/read-only tools with Pi's cancellation, execution, rendering, and noninteractive conventions.

## Goal

Make `pi-gate`, `pi-todo`, and `pi-git` safe and deterministic before adding features.

## Scope

- `pi-gate`: apply deny rules in all enabled modes before fallback behavior.
- Replace unsafe broad shell glob authorization; distinguish exact remembered rules from explicit globs.
- Force ask/deny for control syntax until token-aware parsing or sandbox execution exists.
- Validate gate config, retain last-known-good policy, implement/remove timeout fields, make audit/config writes atomic and bounded.
- Add `project_trust` policy and protected-path handling for read/edit/write.
- `pi-todo`: use `StringEnum`, sequential tool execution, cycle/self-edge rejection, artifact cwd/symlink/collision/rollback safety, and defined idempotency/version semantics.
- `pi-git`: check exit codes, detect non-repos, return typed results, render the full promised bounded snapshot, pass cancellation, and reduce Git process count.

## Outputs

- Security/correctness regression tests.
- Provider-compatible tool schemas.
- Deterministic sequential todo mutation.
- Typed, honest Git snapshot contract.

## Acceptance criteria

- Permissive gate mode cannot bypass deny rules.
- Compound/adversarial shell fixtures cannot escape an allow rule.
- Remembered literals never broaden into globs.
- Parallel todo calls cannot violate lifecycle/claim/revision invariants.
- Todo dependencies reject self and transitive cycles.
- Git failures are never rendered as valid field values; staged/unstaged/untracked/remote scope is visible to the model.
- Noninteractive behavior is explicit and fail-closed where required.

## Verification

- Table-driven adversarial gate suite.
- Google-provider schema compatibility fixture.
- Parallel todo mutation stress test.
- Git fixtures: clean, dirty, detached, no upstream, conflict, non-repo, unusual filenames, abort/timeout.

## Open questions

- Shell parser versus sandbox/operation abstraction?
- Gate audit failure policy: fail open or fail closed?
- Todo default: advisory, mutation-only, or strict?

## Non-goals

- No dashboard/HUD redesign.

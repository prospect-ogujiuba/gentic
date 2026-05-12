# Phase 10 — CI enforcement hardening

Created: 2026-05-12
Purpose: Convert mature anatomy checks into reliable failures.

## Goal

Prevent regression after declarations and migrations have stabilized.

## Scope

- Choose low-risk anatomy rules to make blocking.
- Keep subjective or transitional rules as warnings.
- Update `npm run check` to fail only on agreed violations.

## Candidate blocking rules

- Missing extension README.
- Missing anatomy declaration.
- Invalid declaration mode.
- Discovered resources placed outside expected directories.
- Layered extension missing declared entrypoint.

## Candidate warning-only rules

- `index.ts` line-count threshold.
- Transitional layer mismatch.
- Domain purity import checks until false positives are understood.

## Outputs

- Hardened checker behavior.
- Updated docs explaining blocking vs warning rules.
- Tests for checker behavior if worthwhile.

## Acceptance criteria

- `npm run check` fails on objective anatomy violations.
- Existing repo passes after declarations/migrations.
- Warning output remains concise and actionable.

## Verification

- Run `npm run check`.
- Optionally run checker fixture tests.
- Manually inject a temporary invalid declaration locally and confirm failure, then revert.

## Non-goals

- No new broad rules without baseline evidence.
- No subjective architecture policing in CI.

# Phase 4 — reference declarations

Created: 2026-05-12
Purpose: Prove the anatomy declaration format with known-good examples.

## Goal

Declare anatomy for a small set of representative extensions before touching all extensions.

## Scope

- Add declaration for `pi-todo` as layered reference.
- Add declaration for `pi-gate` as layered-lite/current transitional state.
- Add declaration for one simple hub, preferably `pi-commands`, `pi-skills`, or `pi-prompts`.
- Keep declarations descriptive; do not refactor implementation yet.

## Outputs

- 2–3 declared extensions.
- Checker recognizes declared mode and layers.
- Notes on any mismatch between declaration and current layout.

## Acceptance criteria

- `pi-todo` is represented as the canonical layered example.
- One simple hub is represented without unnecessary layer folders.
- Transitional states can be represented honestly.

## Verification

- Run anatomy checker.
- Expected evidence: declared examples are parsed and reported correctly.
- Manual inspect declaration wording.

## Non-goals

- No all-extension declaration sweep yet.
- No refactor of `pi-gate` or other extensions in this phase.

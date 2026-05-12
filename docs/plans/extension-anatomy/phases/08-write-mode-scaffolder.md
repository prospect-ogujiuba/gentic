# Phase 8 — write-mode scaffolder

Created: 2026-05-12
Purpose: Turn proven dry-run scaffolding into explicit file creation.

## Goal

Allow humans and LLM agents to create standard anatomy resources directly from templates.

## Scope

- Add explicit write/apply mode, likely `--apply`.
- Reuse the same templates and validation from dry-run mode.
- Prevent overwrites unless a future explicit force flag is designed.
- Update barrel files only for surfaces where that is safe and deterministic, such as `pi-commands/commands/index.ts`.

## Outputs

- `/scaffold ... --apply` or equivalent model-callable tools.
- Created files follow the anatomy standard.
- Concise output listing created paths.

## Acceptance criteria

- Default remains safe: dry-run or no writes without explicit apply.
- Generated files pass anatomy checker.
- Existing files are not overwritten accidentally.
- Command scaffolding handles barrel export update or reports the exact manual step.

## Verification

- Scaffold into a temporary/test name.
- Run `npm run check`.
- Run targeted tests for scaffold command/tool.
- Remove test scaffold or keep only if intentionally reviewed.

## Open questions

- Should generated scaffolds be recorded automatically as todo artifacts?
- Should scaffold write mode support `--force`, or avoid it entirely?

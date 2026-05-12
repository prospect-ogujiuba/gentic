# Phase 6 — dry-run scaffolder

Created: 2026-05-12
Purpose: Make templates reachable through Pi without writing files first.

## Goal

Expose scaffold operations safely with dry-run output.

## Scope

- Add `/scaffold ... --dry-run` command or model-callable tools.
- Support extension, command, skill, prompt, and primitive template previews.
- Show target paths and rendered file summaries.
- Avoid writing files in this phase.

## Candidate commands

```txt
/scaffold extension <name> --simple --dry-run
/scaffold extension <name> --layered --dry-run
/scaffold command <name> --dry-run
/scaffold skill <name> --simple --dry-run
/scaffold skill <name> --directory --dry-run
/scaffold prompt <name> --dry-run
/scaffold primitive <name> --dry-run
```

## Outputs

- Dry-run scaffold command/tool.
- Shared template rendering helper if needed.
- Validation for names and destination paths.

## Acceptance criteria

- Dry-run does not modify files.
- Invalid names are rejected clearly.
- Output is concise: target paths plus short descriptions.
- Same templates can later be used for write mode.

## Verification

- Run representative dry-run commands.
- Check `git status` remains clean after dry-run.
- Run `npm test` or targeted tests for command/tool registration.

## Open questions

- Should write mode require explicit `--apply`?
- Should model-callable tools exist in addition to slash commands?

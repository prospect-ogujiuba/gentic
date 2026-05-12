# Phase 1 — intent lock

Created: 2026-05-12
Purpose: Agree the extension anatomy standard before implementation.

## Goal

Decide the standard shape for `simple` and `layered` Gentic extensions.

## Scope

- Define what `simple` means.
- Define what `layered` means.
- Decide where anatomy metadata lives: README block, `extension.anatomy.json`, or both.
- Decide which rules should eventually become enforced.

## Outputs

- Final wording for the standard anatomy.
- Chosen declaration format.
- Initial rule list split into `advisory` and `enforced later`.

## Acceptance criteria

- The standard allows small extensions to stay small.
- The standard prevents large `index.ts` adapter creep.
- The standard names allowed layers: `domain`, `app`, `pi`, `ui`, `config`, `resources`/`docs`.
- User has edited/approved the intent.

## Verification

- Manual review only.
- No code changes.

## Open questions

- Should every extension have a machine-readable file, or is README metadata enough?
- What maximum `index.ts` size is acceptable before warning?
- Should `src/domain` purity be enforced from day one or only reported?

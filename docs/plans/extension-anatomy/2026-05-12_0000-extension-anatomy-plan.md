# Extension anatomy assessment and plan

Created: 2026-05-12
Purpose: Assess current enforcement/templates for Gentic extension anatomy and propose a migration/scaffolding plan.

## Current answer

We have partial conventions, but not an enforceable standard anatomy yet.

Existing support:

- `extensions/README.md` documents Pi discovery and simple-vs-complex resource placement.
- `package.json#pi` and `scripts/check-pi-extension-api.mjs` enforce manifest discovery shape and Pi API contract drift.
- `pi-todo` already acts as the best layered reference: `src/domain`, `src/app`, `src/pi`, `src/ui`.
- `pi-gate` already has a lighter split: `src/pi`, `src/ui`, with config/policy/audit modules.
- `pi-commands`, `pi-skills`, `pi-prompts`, and `pi-primitives` each document their current add-a-resource workflow.
- `pi-catalog/IDEA_BANK.md` contains an unimplemented package surface scaffolder idea.

Gaps:

- No extension declares `simple` vs `layered`.
- No README orientation block is enforced for all extensions.
- No script validates anatomy rules such as thin `index.ts`, allowed `src/*` layers, or resource placement.
- No migration plan is codified for all existing extensions.
- No first-class scaffolder/templates exist for extensions, commands, primitives, or complex skills/prompts beyond prose workflows.

## Recommended enforcement model

Add a small architecture contract before broad refactors:

1. Add per-extension anatomy metadata, preferably in each extension `README.md` orientation block or `extension.anatomy.json`:
   - `mode`: `simple` or `layered`
   - `publicEntry`: usually `index.ts`
   - `layers`: subset of `domain`, `app`, `pi`, `ui`, `config`, `resources`, `docs`
   - `resources`: optional `commands`, `skills`, `prompts`, `themes`, `primitives`
   - `tests`: test files or npm scripts
2. Add `scripts/check-extension-anatomy.mjs` and include it in `npm run check`.
3. Start with warnings/report mode, then make high-confidence rules blocking.
4. Rules should enforce only the core:
   - every extension has `README.md` and declared mode
   - layered extensions keep `index.ts` thin and put behavior under `src/*`
   - `src/domain` must not import Pi runtime packages
   - discovered resources live in `skills/`, `prompts/`, `themes/` as expected
   - simple extensions may remain small, but must explicitly say they are simple

## Migration order

Use `pi-todo` as the reference and migrate by risk/benefit:

1. Codify the standard using `pi-todo` and `pi-gate` as examples.
2. Mark already-small resource hubs as `simple`: `pi-commands`, `pi-skills`, `pi-prompts`, `pi-primitives`, `pi-hud` if it remains thin.
3. Rework `pi-gate` into the light layered form: move config/policy/audit into `src/config`, `src/domain` or `src/app`, and keep `src/pi`/`src/ui` adapters.
4. Rework higher-churn/runtime-heavy extensions: `gentic`, `pi-swe`, `pi-hud`.
5. Rework `pi-catalog` last or alongside scaffolding, because it can become the implementation home for anatomy introspection/scaffolding.
6. Only force full `domain/app/pi/ui/config` shape where there is real behavior; avoid directory theater.

Current rough classification:

- `pi-todo`: layered reference.
- `pi-gate`: layered-lite target.
- `gentic`: likely layered-lite if runtime orchestration grows.
- `pi-swe`: layered or resource-hub-plus-runtime split.
- `pi-hud`: simple unless dashboard logic grows.
- `pi-catalog`: simple now, layered if scaffolder/checker is implemented.
- `pi-git`: simple unless runtime behavior expands.
- `pi-commands`, `pi-skills`, `pi-prompts`, `pi-primitives`: simple resource hubs with templates.

## Scaffolding/template recommendation

Yes, add templates. Prefer disk templates plus a command/tool so LLMs and humans can use the same source of truth.

Suggested location:

```txt
extensions/pi-catalog/templates/
  extension-simple/
  extension-layered/
  command/
  skill-simple/
  skill-directory/
  prompt-simple/
  primitive/
```

Suggested access paths:

- `/scaffold extension <name> --simple|--layered`
- `/scaffold command <name>` -> `extensions/pi-commands/commands/<name>.ts` and updates barrel export
- `/scaffold skill <name> --simple|--directory` -> `extensions/pi-skills/skills/<name>/SKILL.md`
- `/scaffold prompt <name>` -> `extensions/pi-prompts/prompts/<name>.md`
- `/scaffold primitive <name>` -> `extensions/pi-primitives/primitives/<name>/index.ts`
- `gentic scaffold_*` model-callable tools can wrap the same templates for LLM use.

Minimum template contents:

- simple extension: `index.ts`, `README.md` with anatomy declaration and test map.
- layered extension: thin `index.ts`, `src/domain`, `src/app`, `src/pi`, optional `src/ui`/`src/config`, README orientation block.
- command: `PiCommandModule` file plus barrel-update instruction or automated update.
- skill simple: single `SKILL.md` with required frontmatter.
- skill directory: `SKILL.md` plus `references/` or helper file placeholder.
- prompt: frontmatter with `description` and `argument-hint` plus body shape.
- primitive: `index.ts`, optional `triggers.json`, optional `injection.md`.

## Implementation slices

1. Documentation slice: update `extensions/README.md` with the standard anatomy and simple/layered declaration.
2. Audit slice: add anatomy metadata/check script in report-only mode and snapshot current classifications.
3. Template slice: add disk templates and a read-only list command/tool.
4. Scaffolder slice: implement write-capable scaffold command/tool with dry-run first.
5. Migration slice: refactor target extensions one at a time, each with tests.
6. Enforcement slice: turn stable checks from warning to failure.

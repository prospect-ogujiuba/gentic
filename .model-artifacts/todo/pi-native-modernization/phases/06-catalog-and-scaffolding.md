# Phase 6: Catalog and scaffolding

Created: 2026-08-21
Purpose: Turn the existing catalog and scaffold tooling into accurate, low-drift contributor entrypoints for native Pi capabilities.

## Goal

Generate inventory from the pinned Pi contract and scaffold native surfaces safely into the intended project.

## Scope

- Generate/verify package and extension capability catalogs from Pi declarations/docs fixtures.
- Consolidate static catalog tools and overlapping commands into one hierarchical command and one compact tool, or document a deliberate alternative.
- Add catalog entries for commands, tools, events, shortcuts, flags, providers, renderers, markdown transformers, and UI surfaces.
- Make scaffold root/cwd behavior explicit for installed versus self-host development.
- Make multi-file scaffold apply transactional and rollback-safe.
- Replace regex barrel edits with discovery, AST edits, or generated checked files.
- Add templates for minimal/layered extensions, tool, command, event, shortcut, flag, provider, widget/footer/overlay, skill, prompt, and theme.
- Decide and enforce anatomy declaration policy.
- Fix primitive trigger flattening, precompile regexes, isolate load errors, and add primitive status/config if primitives remain.

## Outputs

- Version-stamped catalog.
- Safe project-aware scaffolder.
- Golden-tested native templates.
- Primitive retention/migration decision and implementation contract.

## Acceptance criteria

- Catalog matches current Pi event/API fixtures and reports its source version.
- Scaffold dry-run is complete; apply is atomic; wrong roots are refused clearly.
- Every generated variant typechecks and loads in a smoke session.
- Theme scaffolding and contextual completions exist.
- Primitive failures cannot prevent later modules loading.

## Verification

- Golden catalog and template tests.
- Failure injection at each scaffold write step verifies rollback.
- Temporary project smoke loads every generated variant.
- Primitive invalid JSON/regex/import and context-file trigger tests.

## Open questions

- Keep one compact catalog tool or expose details only through commands/skill?
- Are anatomy files generated, mandatory handwritten declarations, or removed?
- Retain primitives or migrate each to a native surface?

## Non-goals

- No new product plugins before the native extension template is stable.

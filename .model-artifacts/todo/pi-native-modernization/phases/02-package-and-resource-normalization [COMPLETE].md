# Phase 2: Package and resource normalization

Created: 2026-08-21
Purpose: Make Gentic's package use Pi's native extension, skill, prompt, and theme surfaces without redundant runtime loading or command collisions.

## Goal

Create one intentional resource location and one canonical user-facing surface per workflow.

## Scope

- Inventory actual Pi command provenance after load, including numeric collision suffixes.
- Decide whether suite-wide skills/prompts move to root directories.
- Remove no-op `pi-prompts` and `pi-skills` runtime entrypoints if native discovery does not require them.
- Choose the canonical `pi-swe` representation; remove or materially differentiate nine mirrored skill/prompt pairs.
- Fix seven invalid SWE artifact roots to approved kinds.
- Add skill frontmatter, prompt argument/frontmatter, resource collision, package glob, and theme-role validation.
- Decide whether themes and resources are core or optional profiles.

## Outputs

- Approved resource ownership map.
- Collision-free command inventory.
- Shared resource validators and tests.
- Migration notes for renamed/removed invocations.

## Acceptance criteria

- Every skill/prompt has a unique intentional invocation or a documented collision reason.
- No no-op runtime extension loads solely to own native files.
- All referenced `.model-artifacts/<kind>` values use approved kinds.
- All 12 themes validate against current Pi roles.
- Package discovery tests cover inclusions, exclusions, and duplicate names.

## Verification

- Load package in Pi and capture `pi.getCommands()` provenance.
- Run static validators across every skill, prompt, theme, and manifest glob.
- Smoke-test representative skill, prompt, and theme after `/reload`.

## Open questions

- Skills only for SWE, or lightweight prompts with different names/purposes?
- Root-owned versus extension-owned resources?

## Non-goals

- No change to SWE runtime policy or todo persistence.

# Phase 5 — template files

Created: 2026-05-12
Purpose: Add editable disk templates before building a scaffolder.

## Goal

Create a source-of-truth template set for humans and LLMs.

## Scope

Add templates under a chosen location, likely:

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

## Outputs

- Template for simple extension.
- Template for layered extension.
- Template for `pi-commands/commands` command module.
- Template for simple skill.
- Template for directory skill with helper/reference placeholder.
- Template for simple prompt.
- Template for primitive.

## Acceptance criteria

- Templates use placeholders consistently.
- Templates follow the documented anatomy.
- Templates do not get discovered by Pi as live resources accidentally.
- No scaffolder writes files yet.

## Verification

- Manual inspect template tree.
- Run `npm run check`.
- Confirm package discovery does not treat templates as active extensions/skills/prompts.

## Open questions

- Should templates live in `pi-catalog`, a new `pi-scaffold`, or `.docs/templates`?
- What placeholder syntax should be used: `{{name}}`, `$NAME`, or comment markers?

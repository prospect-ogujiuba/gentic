---
name: add-skill
description: Create or update a Gentic pi skill under extensions/pi-skills. Use when the user wants a repeatable on-demand workflow, capability package, or skill-like instructions.
---

# Add Skill

Use this workflow to create or update a reusable Gentic skill.

## Inputs

The user should provide the desired skill name and purpose. If either is unclear, ask one concise clarification before writing files.

## Workflow

1. Inspect `extensions/pi-skills/README.md` and existing `extensions/pi-skills/skills/*/SKILL.md` files.
2. Choose a valid skill name:
   - lowercase `a-z`, `0-9`, and hyphens only
   - no leading/trailing hyphen
   - no consecutive hyphens
   - max 64 characters
3. Create or update `extensions/pi-skills/skills/<name>/SKILL.md`.
4. Add required frontmatter:
   - `name`: exactly `<name>`
   - `description`: specific description of what the skill does and when to use it
5. Write concise Markdown instructions that include:
   - purpose and activation conditions
   - expected inputs
   - step-by-step workflow
   - verification or success criteria
   - relative links to any references/scripts/assets, if needed
6. Add helper files only when they materially improve repeatability.
7. Verify the skill follows pi skill naming and frontmatter rules.
8. Report the skill path and invocation: `/skill:<name>` after `/reload`.

## Constraints

- Keep the skill narrow and composable.
- Do not create broad catch-all skills.
- Do not duplicate an existing skill name.
- Keep large reference material out of `SKILL.md`; place it under the skill directory and link to it.

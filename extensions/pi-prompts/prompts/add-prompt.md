---
description: Create or update a Gentic prompt template in extensions/pi-prompts
argument-hint: "<name> [purpose/details]"
---
Create or update a reusable pi prompt template for Gentic.

Target prompt name: `$1`
Purpose/details: `${@:2}`

Use this repeatable workflow:

1. Inspect `extensions/pi-prompts/README.md` and existing `extensions/pi-prompts/prompts/*.md`.
2. Choose a kebab-case filename: `extensions/pi-prompts/prompts/<name>.md`.
3. Add YAML frontmatter with:
   - `description`: concise autocomplete text.
   - `argument-hint`: optional expected arguments.
4. Write a focused Markdown prompt body that:
   - States the task clearly.
   - Defines expected inputs using `$1`, `$2`, `$@`, or `$ARGUMENTS` when useful.
   - Gives concise success criteria or output shape.
   - Avoids project-specific implementation details unless requested.
5. Verify the file is valid Markdown and does not duplicate an existing prompt name.
6. Report the prompt path and how to invoke it after `/reload`.

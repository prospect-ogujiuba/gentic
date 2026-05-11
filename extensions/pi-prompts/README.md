# pi-prompts

Central extension for Gentic prompt templates.

Prompt templates are Markdown files discovered by `package.json#pi.prompts` from `extensions/**/prompts/**/*.md`. The filename becomes the slash command name.

## Add a prompt

1. Create `prompts/<name>.md`.
2. Add YAML frontmatter:
   - `description`: short autocomplete text.
   - `argument-hint`: optional usage hint, e.g. `"<name> [details]"`.
3. Write the reusable prompt body using `$1`, `$2`, `$@`, or `$ARGUMENTS` as needed.
4. Run `/reload` in pi, then invoke it as `/<name>`.

Keep prompts focused, repeatable, and explicit about expected inputs and output shape.

# pi-prompts

Central extension for Gentic prompt templates.

Prompt templates are Markdown files discovered by `package.json#pi.prompts` from `extensions/**/prompts/**/*.md`. The filename becomes the slash command name.

## Anatomy

- **Mode:** `simple`
- **Public entry:** `index.ts`
- **Layers:** `pi`, `resources`
- **Resources:** `prompts/`
- **Machine declaration:** `extension.anatomy.json`
- **Reference role:** simple hub example; no `src/*` layer folders are needed because prompt templates are discovered directly.
- **Mismatch notes:** none; `index.ts` is a no-runtime owner namespace and prompt resources live in `prompts/`.

## Add a prompt

1. Create `prompts/<name>.md`.
2. Add YAML frontmatter:
   - `description`: short autocomplete text.
   - `argument-hint`: optional usage hint, e.g. `"<name> [details]"`.
3. Write the reusable prompt body using `$1`, `$2`, `$@`, or `$ARGUMENTS` as needed.
4. Run `/reload` in pi, then invoke it as `/<name>`.

Keep prompts focused, repeatable, and explicit about expected inputs and output shape.

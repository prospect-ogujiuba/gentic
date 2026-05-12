# pi-catalog templates

Editable source templates for Gentic Pi package resources. These files are for humans, LLMs, and a future scaffolder; no scaffolder writes files yet.

## Placeholder syntax

Use double-curly placeholders consistently:

- `{{kebabName}}` for filenames, command names, skill names, and package ids.
- `{{camelName}}` for TypeScript values.
- `{{pascalName}}` for exported TypeScript types/functions.
- `{{description}}` for user-facing descriptions.

## Discovery guardrails

Templates intentionally live under `extensions/pi-catalog/templates/` and use `.template.*` filenames for Pi-discoverable resource shapes. Do not add live `skills/`, `prompts/`, or `themes/` directories under this template tree; package discovery may treat those as active resources.

## Template set

- `extension-simple/`: simple extension folder shape.
- `extension-layered/`: layered extension folder shape.
- `command/`: `pi-commands/commands` command module shape.
- `skill-simple/`: single-file skill content shape, stored inertly.
- `skill-directory/`: directory skill content with helper/reference placeholders, stored inertly.
- `prompt-simple/`: prompt template content shape, stored inertly.
- `primitive/`: `pi-primitives/primitives` primitive shape.

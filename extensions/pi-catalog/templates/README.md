# pi-catalog templates

Inert source templates used by `/scaffold`. `.template.*` names prevent Pi package discovery inside this tree.

## Template set

- `extension-simple/`, `extension-layered/`: minimal and layered extensions.
- `tool/`, `command/`, `event/`, `shortcut/`, `flag/`, `provider/`: native Pi registrations.
- `widget/`, `footer/`, `overlay/`: UI surfaces.
- `skill-simple/`, `skill-directory/`, `prompt-simple/`, `theme/`: package resources.
- `primitive/`: retained lightweight primitive modules.

## Anatomy declaration policy

Scaffolds do **not** generate `extension.anatomy.json`. Declarations are optional handwritten architecture records, not runtime inputs or generated truth. `npm run check:anatomy` validates any declaration that exists and derives inventory when it does not. Layered scaffold structure is enforced directly by its generated files and smoke tests.

## Guardrails

Templates use double-curly placeholders and must render with none unresolved. Native scaffolds are standalone extensions; no barrel source edit is required. Golden tests typecheck and smoke-load every generated variant.

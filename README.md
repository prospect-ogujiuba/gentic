# Gentic

`gentic` is a pi package suite organized around a surface catalog.

## Install

Install Gentic as a normal pi package globally:

```bash
pi install npm:gentic
pi install /absolute/path/to/gentic
```

For a project-local install:

```bash
pi install -l npm:gentic
pi install -l /absolute/path/to/gentic
```

The `-l` flag writes the package reference to `.pi/settings.json` for the current project instead of your global pi settings.

## Filtering

Gentic does not maintain its own enable/disable registry. Use pi package filters against the stable paths below to load the whole suite or selected surfaces.

Example: load most code-backed Gentic surfaces from npm, exclude risky execution/provider behavior, include only review skills and planning/review prompts, and keep a dark theme.

```json
{
  "packages": [
    {
      "source": "npm:gentic",
      "extensions": [
        "extensions/*/*/index.ts",
        "!extensions/exec/**",
        "!extensions/provider/**",
        "!extensions/tool-control/destructive-approval/**",
        "!extensions/tool/experimental/**"
      ],
      "skills": ["skills/review/**"],
      "prompts": ["prompts/review/**/*.md", "prompts/planning/**/*.md"],
      "themes": ["themes/dark/*.json"]
    }
  ]
}
```

## Surface index

| Surface | Location | README |
| --- | --- | --- |
| `package` | `package.json`, `catalog/surfaces.ts` | `catalog/surfaces.ts` |
| `extension` | `extensions/extension/` | [extensions/extension](extensions/extension/README.md) |
| `skill` | `skills/` | [skills](skills/README.md) |
| `prompt-template` | `prompts/` | [prompts](prompts/README.md) |
| `theme` | `themes/` | [themes](themes/README.md) |
| `context` | `extensions/context/` | [extensions/context](extensions/context/README.md) |
| `flag` | `extensions/flag/` | [extensions/flag](extensions/flag/README.md) |
| `command` | `extensions/command/` | [extensions/command](extensions/command/README.md) |
| `shortcut` | `extensions/shortcut/` | [extensions/shortcut](extensions/shortcut/README.md) |
| `tool` | `extensions/tool/` | [extensions/tool](extensions/tool/README.md) |
| `event` | `extensions/event/` | [extensions/event](extensions/event/README.md) |
| `event-bus` | `extensions/event-bus/` | [extensions/event-bus](extensions/event-bus/README.md) |
| `session-state` | `extensions/session-state/` | [extensions/session-state](extensions/session-state/README.md) |
| `session-labels` | `extensions/session-labels/` | [extensions/session-labels](extensions/session-labels/README.md) |
| `tool-control` | `extensions/tool-control/` | [extensions/tool-control](extensions/tool-control/README.md) |
| `model-control` | `extensions/model-control/` | [extensions/model-control](extensions/model-control/README.md) |
| `provider` | `extensions/provider/` | [extensions/provider](extensions/provider/README.md) |
| `model` | `extensions/model/`, `catalog/` | [extensions/model](extensions/model/README.md) |
| `exec` | `extensions/exec/` | [extensions/exec](extensions/exec/README.md) |
| `message-injection` | `extensions/message-injection/` | [extensions/message-injection](extensions/message-injection/README.md) |
| `message-renderer` | `extensions/message-renderer/` | [extensions/message-renderer](extensions/message-renderer/README.md) |
| `ui-component` | `extensions/ui-component/` | [extensions/ui-component](extensions/ui-component/README.md) |
| `sdk` | `extensions/sdk/`, `catalog/` | [extensions/sdk](extensions/sdk/README.md) |
| `rpc` | `extensions/rpc/` | [extensions/rpc](extensions/rpc/README.md) |

## Repository shape

Gentic uses pi's first-class package resources while keeping a typed taxonomy in `catalog/surfaces.ts`.

```txt
catalog/      # surface taxonomy and package metadata
extensions/   # code-backed surfaces, grouped by surface
skills/       # pi skills
prompts/      # pi prompt templates
themes/       # pi themes
```

## Discovery details

`package.json` is the source of runtime discovery:

```json
{
  "pi": {
    "extensions": ["./extensions/*/*/index.ts"],
    "skills": ["./skills/**/SKILL.md"],
    "prompts": ["./prompts/**/*.md", "!./prompts/**/README.md"],
    "themes": ["./themes/**/*.json"]
  }
}
```

Every code-backed Gentic extension is a directory: `extensions/<surface>/<extension-name>/index.ts`. Surface folders are categories, extension folders are loadable units, and helper files beside `index.ts` are never loaded as standalone extensions.

For first-class resources, discovery is also constrained to avoid accidental docs-as-resources: skills load only `SKILL.md` files, prompts exclude `README.md`, and themes load only JSON files.

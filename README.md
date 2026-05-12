# Gentic

`gentic` is a low-config Pi package suite. Pi owns runtime discovery; Gentic only provides package resources and extension-backed examples.

## Install

Install Gentic as a normal Pi package globally:

```bash
pi install npm:gentic
pi install /absolute/path/to/gentic
```

For a project-local install:

```bash
pi install -l npm:gentic
pi install -l /absolute/path/to/gentic
```

The `-l` flag writes the package reference to `.pi/settings.json` for the current project instead of your global Pi settings.

## Runtime discovery

`package.json` points Pi at both root resources and extension-owned resources:

```json
{
  "pi": {
    "extensions": ["./extensions"],
    "skills": [
      "./skills",
      "./extensions/**/skills",
      "!./skills/**/README.md",
      "!./extensions/**/skills/**/README.md"
    ],
    "prompts": [
      "./prompts/**/*.md",
      "./extensions/**/prompts/**/*.md",
      "!./prompts/**/README.md",
      "!./extensions/**/prompts/**/README.md"
    ],
    "themes": ["./themes/**/*.json", "./extensions/**/themes/**/*.json"]
  }
}
```

This keeps authoring simple while allowing complex bundled resources:

| Resource | Simple file | Complex / extension-owned resource |
| --- | --- | --- |
| Extension | `extensions/foo.ts` | `extensions/foo/index.ts` |
| Skill | `skills/foo.md` | `skills/foo/SKILL.md` or `extensions/foo/skills/foo-helper/SKILL.md` |
| Prompt template | `prompts/foo.md` | `extensions/foo/prompts/foo-plan.md` |
| Theme | `themes/foo.json` | `extensions/foo/themes/foo.json` |

Nested `package.json` files inside extension folders are not used for Pi package discovery. If an extension owns skills, prompts, or themes, put them in its `skills/`, `prompts/`, or `themes/` child directory so the top-level manifest can discover them.

First-class Gentic surfaces are only things Pi discovers directly from package metadata:

| Surface | Location | Discovery |
| --- | --- | --- |
| `package` | `package.json`, `src/pi-contract.ts` | package manifest |
| `extension` | `extensions/` | `pi.extensions` |
| `skill` | `skills/`, `extensions/**/skills` | `pi.skills` |
| `prompt-template` | `prompts/`, `extensions/**/prompts` | `pi.prompts` |
| `theme` | `themes/`, `extensions/**/themes` | `pi.themes` |

Everything else is Pi extension API behavior. Gentic does not catalog those behaviors as package surfaces or encode them into paths.

## Filtering

Gentic does not maintain its own enable/disable registry. Use Pi package filters against stable resource paths.

Example: load all Gentic extensions, include only review skills and planning/review prompts, and keep a dark theme.

```json
{
  "packages": [
    {
      "source": "npm:gentic",
      "extensions": ["extensions"],
      "skills": ["skills/review/**", "extensions/**/skills/review/**"],
      "prompts": ["prompts/review/**/*.md", "prompts/planning/**/*.md", "extensions/**/prompts/review/**/*.md"],
      "themes": ["themes/dark/*.json", "extensions/**/themes/dark/*.json"]
    }
  ]
}
```

## Repository shape

```txt
src/              # Shared Gentic source, including Pi contract constants
extensions/       # Pi extensions plus extension-owned skills/prompts/themes
skills/           # Package-level Pi skills
prompts/          # Package-level Pi prompt templates
themes/           # Package-level Pi themes
scripts/          # maintenance checks against installed Pi
docs/             # Repository conventions, including model artifacts
.model-artifacts/ # Generated reports, plans, findings, logs, specs, and todo artifacts
```

For first-class resources, discovery is constrained to avoid accidental docs-as-resources: skill and prompt `README.md` files are excluded by the package manifest.

## Staying in sync with Pi

Do not copy Pi source files into Gentic as permanent config. For extension API drift, run:

```bash
npm run check:pi-api
```

The check reads the installed `@earendil-works/pi-coding-agent` package directly and verifies that Gentic's package assumptions still line up with the local Pi install.

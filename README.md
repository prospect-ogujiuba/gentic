# Gentic

`gentic` is a low-config Pi package suite. Pi owns runtime discovery; Gentic only provides package resources and extension-backed examples.

## Install

Install the permission system from npm, then install Gentic 0.x from a pinned Git tag or trusted checkout:

```bash
pi install npm:@gotgenes/pi-permission-system
pi install git:github.com/prospect-ogujiuba/gentic@v0.1.0
# Or: pi install /absolute/path/to/gentic
```

For project-local installs, add `-l` to both commands. It writes the package reference to `.pi/settings.json` instead of global settings. After local source changes, run `/reload` inside Pi.

The `npm:gentic` name is not supported while `package.json#private` is true. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for clean-checkout development.

## Development baseline

Gentic currently supports exactly `@earendil-works/pi-coding-agent` **0.84.2**. The exact pin keeps the compatibility artifact and lockfile reproducible; widening the supported range requires updating and verifying the compatibility baseline first.

Development and CI require Node.js **22.19.0 or newer**. From a clean checkout:

```bash
npm ci
npm run typecheck
npm run check
npm test
```

`package.json#engines` enforces the Node requirement, and `check:pi-api` verifies that the manifest, lockfile, installed Pi package, and all `ExtensionAPI.on` event overloads match the documented baseline.

## Runtime discovery

`package.json` points Pi at both root resources and extension-owned resources:

```json
{
  "pi": {
    "extensions": [
      "./extensions"
    ],
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

`@gotgenes/pi-permission-system` is installed as its own npm Pi package rather than bundled with Gentic. The migrated baseline policy is tracked at [`config/pi-permission-system.json`](config/pi-permission-system.json). Copy it to the global extension config path before first use:

```bash
mkdir -p ~/.pi/agent/extensions/pi-permission-system
cp config/pi-permission-system.json ~/.pi/agent/extensions/pi-permission-system/config.json
```

The replacement uses command decomposition and most-restrictive resolution, keeps permission review logging enabled, allows external directories like the previous local setup, denies writes to `.env` and `.git`, and asks for bash commands outside the migrated allowlist. It protects model-callable tools; commands explicitly entered through Pi's separate `user_bash` path are trusted as direct user actions. Use `/permission-system` for runtime settings. Project-scoped overrides remain subject to Pi project trust.

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

Everything else is Pi extension API behavior. `pi-catalog` inventories those APIs as native capability groups, but does not mislabel them as package resources or encode them into manifest paths.

## Filtering

Gentic does not maintain its own enable/disable registry. Use Pi package filters against stable resource paths.

Use the checked native filter fragments in [`profiles/core.json`](profiles/core.json) and [`profiles/full.json`](profiles/full.json). Copy a profile's nested `package` object into the Pi settings `packages` array. Profiles narrow `package.json#pi`; they do not add a Gentic resource kind or patch plugin internals.

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

For first-class resources, discovery is constrained to avoid accidental docs-as-resources: skill and prompt `README.md` files are excluded by the package manifest. Ownership and invocation migration are documented in [`docs/pi-package-resources.md`](docs/pi-package-resources.md).

## Staying in sync with Pi

Do not copy Pi source files into Gentic as permanent config. For extension API drift, run:

```bash
npm run check:pi-api
```

The check reads the installed `@earendil-works/pi-coding-agent` package directly and verifies that Gentic's package assumptions still line up with the local Pi install.

Run `npm run check:resources` for native resource validation, `npm run check:inventory` for source/manifest/profile drift, and `npm run check:commands` for collision-free command provenance.

Preview a Pi release with `npm run pi:update -- --target <version> --report <path>`. Release policy, support window, performance budgets, and the verification checklist live in [`docs/release.md`](docs/release.md). Native surface creation is documented in [`docs/plugin-guide.md`](docs/plugin-guide.md).

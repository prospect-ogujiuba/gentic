# Contributing to Gentic

Gentic is a native Pi package. Pi owns discovery and lifecycle; contributors should add the smallest supported native surface instead of creating a parallel registry.

## Clean checkout

Requirements: Git, Node.js 22.19.0 or newer, npm, and Pi 0.84.2.

```sh
git clone https://github.com/prospect-ogujiuba/gentic.git
cd gentic
npm ci
npm run typecheck
npm run check
npm run check:commands
npm run check:performance
npm test
```

Install the checkout into a disposable project and reload after edits:

```sh
cd /path/to/disposable-project
pi install -l /absolute/path/to/gentic
pi
# inside Pi: /reload
```

Use `pi list` to confirm the local package. A package install runs with full system access; use only a trusted checkout.

## Create a native surface

Use the single project-aware path:

```text
/scaffold <kind> <name> [--minimal|--layered|--simple|--directory]
/scaffold <kind> <name> ... --apply
/reload
```

Dry-run is the default. Supported kinds are extension, tool, command, event, shortcut, flag, provider, widget, footer, overlay, skill, prompt, theme, and retained primitive. See [`docs/plugin-guide.md`](docs/plugin-guide.md) for ownership, target paths, and verification.

Do not hand-edit a command barrel, add a nested package manifest, or add a new package resource kind. Use Pi's `extensions`, `skills`, `prompts`, and `themes` manifest fields.

## Ownership

| Area | Owner path | Targeted verification |
| --- | --- | --- |
| Package/catalog/scaffolding | `extensions/gentic`, `extensions/pi-catalog`, `extensions/pi-commands`, `src/pi-contract.ts` | `npm run check:catalog`, scaffold tests |
| Context/HUD | `extensions/pi-context`, `extensions/pi-hud` | `test/pi-context-*.test.ts`, `test/pi-hud-*.test.ts` |
| Safety policy/git | `config/pi-permission-system.json`, `extensions/pi-git` | `npm run test:permissions`, `test/pi-git.test.ts` |
| SWE/todos | `extensions/pi-swe`, `extensions/pi-todo` | `npm run test:swe`, `npm run test:todo` |
| Shared prompt behavior | `extensions/pi-primitives` | `npm run test:primitives` |
| Package resources | owner-local or root `skills/`, `prompts/`, `themes/` | `npm run check:resources` |

Every extension folder needs a truthful `README.md`. `extension.anatomy.json` is optional and handwritten; `npm run check:anatomy` validates it only when present.

## Verification and handoff

Run targeted tests while iterating, then before handoff:

```sh
npm run typecheck
npm run check
npm run check:commands
npm run check:performance
npm test
```

Use `npm run release:verify -- --report <path>` for a versioned release evidence report. Generated repository-wide reports belong under `.model-artifacts/system/reports/` and are not package resources.

## Updating Pi

Never widen or change one Pi dependency alone. Preview declaration and changelog drift:

```sh
npm run pi:update -- --target <version> --report .model-artifacts/system/reports/pi-update/YYYY-MM-DD_HHMM-<version>.md
```

The dry-run does not modify pins. After reviewing the report, use `--apply` on a dedicated branch; it updates all three pinned Pi packages, regenerates catalogs/inventory, and runs the compatibility matrix. See [`docs/release.md`](docs/release.md).

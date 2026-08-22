# Pi package resource ownership

Gentic uses Pi's package manifest as the only resource loader. Resource directories do not need no-op runtime extensions.

## Ownership map

| Resource | Owner and location | Invocation | Profile |
|---|---|---|---|
| Suite-wide prompts | `prompts/*.md` | `/<filename>` | selected explicitly by core; all in full |
| Suite-wide skills | `skills/*/SKILL.md` | `/skill:<name>` | selected explicitly by core; all in full |
| Extension-specific prompts | `extensions/<owner>/prompts/*.md` | `/<filename>` | owner filter; all in full |
| Extension-specific skills | `extensions/<owner>/skills/*/SKILL.md` | `/skill:<name>` | owner filter; all in full |
| Themes | `themes/**/*.json` | `/settings` theme selection | disabled in core; all in full |
| Native extension behavior (not a resource kind) | `extensions/<owner>/index.ts` | owner-defined | exact extension filters in core/full profiles |

`pi-prompts` and `pi-skills` no-op extension entrypoints were removed. Their `add-prompt` and `add-skill` resources moved to the root-owned locations above.

## SWE canonical surface

`pi-swe` owns runtime `/swe status`, `/swe config`, and `/swe orchestrate`. Lifecycle guidance is skill-only under `extensions/pi-swe/skills/`.

Removed mirrored prompt invocations such as `/swe-plan` and `/swe-verify` migrate to `/skill:swe-plan` and `/skill:swe-verify`. The same rule applies to all nine `swe-*` lifecycle skills.

## Validation

- `npm run check:resources` validates manifest discovery, frontmatter, unique invocations, approved model-artifact kinds, and current Pi theme roles.
- `npm run check:commands` loads the package in Pi RPC mode, prints `get_commands` provenance, and rejects numeric collision suffixes.
- `npm run check:inventory` verifies generated extension/resource ownership and core/full profile paths.
- `test/package-resources.test.ts` covers manifest inclusion, exclusion, and duplicate resource names.
- `test/release-inventory.test.ts` compares the generated source inventory with runtime registration smoke output.

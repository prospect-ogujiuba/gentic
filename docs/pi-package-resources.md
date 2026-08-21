# Pi package resource ownership

Gentic uses Pi's package manifest as the only resource loader. Resource directories do not need no-op runtime extensions.

## Ownership map

| Resource | Owner and location | Invocation | Profile |
|---|---|---|---|
| Suite-wide prompts | `prompts/*.md` | `/<filename>` | core |
| Suite-wide skills | `skills/*/SKILL.md` | `/skill:<name>` | core |
| Extension-specific prompts | `extensions/<owner>/prompts/*.md` | `/<filename>` | owner-defined |
| Extension-specific skills | `extensions/<owner>/skills/*/SKILL.md` | `/skill:<name>` | owner-defined |
| Themes | `themes/**/*.json` | `/settings` theme selection | optional user choice, package-core resource |
| Runtime commands/tools/events | `extensions/<owner>/index.ts` | owner-defined | core extension surface |

`pi-prompts` and `pi-skills` no-op extension entrypoints were removed. Their `add-prompt` and `add-skill` resources moved to the root-owned locations above.

## SWE canonical surface

`pi-swe` owns runtime `/swe status`, `/swe config`, and `/swe orchestrate`. Lifecycle guidance is skill-only under `extensions/pi-swe/skills/`.

Removed mirrored prompt invocations such as `/swe-plan` and `/swe-verify` migrate to `/skill:swe-plan` and `/skill:swe-verify`. The same rule applies to all nine `swe-*` lifecycle skills.

## Validation

- `npm run check:resources` validates manifest discovery, frontmatter, unique invocations, approved model-artifact kinds, and current Pi theme roles.
- `npm run check:commands` loads the package in Pi RPC mode, prints `get_commands` provenance, and rejects numeric collision suffixes.
- `test/package-resources.test.ts` covers manifest inclusion, exclusion, and duplicate resource names.

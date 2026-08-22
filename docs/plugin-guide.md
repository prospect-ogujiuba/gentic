# Native surface and plugin guide

## One creation path

Run `/scaffold` from the intended Pi project. Preview first, inspect every target, then repeat with `--apply` and `/reload`.

| Requested surface | Scaffold command | Generated owner |
| --- | --- | --- |
| Minimal extension | `/scaffold extension foo --minimal` | `extensions/foo/` |
| Layered extension | `/scaffold extension foo --layered` | `extensions/foo/` with `src/{domain,app,pi,ui}` |
| Tool | `/scaffold tool foo` | standalone `extensions/foo/` |
| Command | `/scaffold command foo` | standalone `extensions/foo/` |
| Event hook | `/scaffold event foo` | standalone `extensions/foo/` |
| Shortcut / flag | `/scaffold shortcut foo`, `/scaffold flag foo` | standalone extension |
| Provider | `/scaffold provider foo` | standalone extension; provider review required |
| Widget / footer / overlay | `/scaffold widget foo`, `/scaffold footer foo`, `/scaffold overlay foo` | standalone UI extension |
| Skill | `/scaffold skill foo --simple` or `--directory` | `skills/foo/` |
| Prompt | `/scaffold prompt foo` | `prompts/foo.md` |
| Theme | `/scaffold theme foo` | `themes/foo.json` |
| Primitive | `/scaffold primitive foo` | `extensions/pi-primitives/primitives/foo/` |

Primitive use is restricted to small, shared runtime behavior. New product plugins use native extensions.

## Plugin contract

1. Keep the generated `README.md` and replace every TODO.
2. Register only the native Pi APIs the plugin owns.
3. Put extension-owned skills/prompts/themes in the standard child directories.
4. Keep state session-scoped unless persistence is explicitly required.
5. Clean timers, widgets, footer/modal handles, and external resources on session shutdown/reload.
6. Add a smoke test that loads the extension and asserts its registrations.
7. Add focused behavior tests; avoid unrelated suite refactors.

An anatomy declaration is optional and never generated. If a maintainer adds one, it is a handwritten architecture record and must pass `npm run check:anatomy`.

## Representative capability check

```text
/scaffold tool contributor-smoke
/scaffold tool contributor-smoke --apply
/reload
```

Then run `npm run typecheck` and the scaffold smoke tests. Remove the sample after verification. `test/pi-commands-scaffold.test.ts` performs the same process in a temporary Pi project for every supported variant.

## Discovery and profiles

`package.json#pi` is the source of truth. Do not add profile-specific imports or conditionals to plugin internals. Enable subsets with Pi's native package filters; copy the package object from [`profiles/core.json`](../profiles/core.json) or [`profiles/full.json`](../profiles/full.json) into `settings.json`. See [`profiles.md`](profiles.md).

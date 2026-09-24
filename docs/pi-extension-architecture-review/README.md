# Pi Extension Architecture Review

## Blunt verdict

The code is generally careful and unusually well-tested. The weak point is **architecture**, not sloppiness: several extensions have blurred ownership, private cross-extension coupling, or far more machinery than their value justifies.

| Extension | Surface | Verdict |
|---|---|---|
| `pi-hud` | widget, command, 9 events | **Poorly designed** |
| `pi-swe` | `swe` + `todo`, tools, commands, UI, 6 events | **Overgrown / poorly bounded** |
| `pi-context` | command, pressure monitoring, exports | **Overengineered** |
| `pi-primitives` | prompt-policy framework | **Wrong abstraction** |
| `pi-commands` | `clear`, `scaffold` | **Mixed; scaffolder boundary is bad** |
| `pi-catalog` | catalog command/tool, templates | **Mixed; confused ownership** |
| `pi-git` | snapshot command/tool | **Good, slightly monolithic** |
| `pi-artifacts` | artifact tool | **Good** |

## Priority order

1. Remove `pi-hud` imports from sibling `src/` trees.
2. Separate `todo` from `pi-swe`.
3. Retire `pi-primitives`.
4. Move scaffold templates out of `pi-catalog`.
5. Replace `pi-context` object introspection with a typed Pi telemetry API.
6. Extract shared bounded-process and secure-file-publication utilities.

## Recurring design smell

The recurring design smell is **careful implementation compensating for poor boundaries**.

The tests make these structures reliable; they do not make them simple or well-owned.

## Files in this review

- [01 — pi-hud](./01-pi-hud.md)
- [02 — pi-swe](./02-pi-swe.md)
- [03 — pi-context](./03-pi-context.md)
- [04 — pi-primitives](./04-pi-primitives.md)
- [05 — pi-commands + pi-catalog](./05-pi-commands-and-pi-catalog.md)
- [06 — pi-git](./06-pi-git.md)
- [07 — pi-artifacts](./07-pi-artifacts.md)

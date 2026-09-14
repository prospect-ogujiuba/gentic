# Discovery surface migration

## Transition

- `/catalog status` replaces `/gentic status` and `/gentic commands`.
- `/catalog search <term>` replaces `/gentic find <term>` and searches both commands and tools.
- `gentic_catalog` replaces `gentic_status` for model-callable discovery.
- `/gentic run ...` has no replacement because every result shows the directly invokable `/<command>` form.
- Resource reload remains Pi-owned rather than a catalog operation.
- The former static runtime capability sections were removed; `catalog/pi-native-capabilities.json` remains build-time release evidence.

No compatibility aliases are retained because aliases would preserve the duplicate routing surface prohibited by the consolidated contract. Unknown legacy commands/tools now follow Pi's normal unavailable-command/tool behavior.

## Rollback

A source rollback can restore `extensions/gentic/` and its entries in `profiles/core.json`, `profiles/full.json`, runtime smoke tests, and performance checks. After restoration, run `npm run generate:inventory` before release verification. The migration changes no persisted user or session data, so no data rollback is required.

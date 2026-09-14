# pi-catalog

`pi-catalog` is Gentic's single runtime discovery surface for registered Pi commands and tools.

## Anatomy

- **Mode:** `layered`
- **State:** `layered-lite`
- **Public entry:** `index.ts`
- **Layers:** `app`, `pi`
- **Machine declaration:** optional handwritten `extension.anatomy.json`

## Orientation block

- **Command:** `/catalog [status|search <term>]`.
- **Tool:** `gentic_catalog` with `status` and `search` operations.
- **Runtime source:** `pi.getCommands()`, `pi.getAllTools()`, and canonical `sourceInfo`.
- **Direct invocation:** search results show `/<command>` syntax; the catalog never proxies commands.
- **Bounds:** search terms are limited to 200 characters and results to 25 commands plus 25 tools. Display fields, owner lists, and structured match details are also clipped; exact runtime totals remain visible.
- **Generated fixture:** `catalog/pi-native-capabilities.json` is build-time release evidence, not a runtime data source.
- **Refresh:** `npm run generate:catalog`.
- **Verification:** `npm run check:catalog` and `node --experimental-strip-types --test test/pi-catalog.test.ts test/gentic-demo.test.ts`.

The legacy `/gentic` command, `gentic_status` tool, and static runtime capability presentation were removed. `scripts/generate-pi-catalog.ts --check` continues to reject stale build-time fixtures or capability entries absent from the installed Pi declarations.

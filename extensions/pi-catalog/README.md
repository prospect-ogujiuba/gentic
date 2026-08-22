# pi-catalog

`pi-catalog` exposes a checked, version-stamped inventory of Pi package surfaces and native extension capabilities.

## Anatomy

- **Mode:** `layered`
- **State:** `layered-lite`
- **Public entry:** `index.ts`
- **Layers:** `app`, `pi`
- **Machine declaration:** optional handwritten `extension.anatomy.json`

## Orientation block

- **Command:** `/catalog [surfaces [id]|events|commands|tools|shortcuts|flags|providers|renderers|markdown-transformers|ui-surfaces]`.
- **Tool:** `gentic_catalog`, the single compact model-callable catalog tool.
- **Source:** pinned `@earendil-works/pi-coding-agent` declarations and docs named in `src/pi-contract.ts`.
- **Generated fixture:** `catalog/pi-native-capabilities.json`.
- **Refresh:** `npm run generate:catalog`.
- **Verification:** `npm run check:catalog` and `node --experimental-strip-types --test test/pi-catalog.test.ts`.

The generated fixture reports its Pi source version. `scripts/generate-pi-catalog.ts --check` refuses stale fixtures or capability entries absent from the installed declarations.

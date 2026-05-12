# pi-catalog

`pi-catalog` exposes Gentic's first-class Pi package surfaces and extension event constants as commands and model-callable tools.

## Anatomy

- **Mode:** `layered`
- **State:** `layered-lite`
- **Public entry:** `index.ts`
- **Layers:** `app`, `pi`
- **Machine declaration:** `extension.anatomy.json`
- **Reference role:** catalog layered-lite example; `index.ts` stays a thin adapter.
- **Mismatch notes:** none known; app catalog formatting lives in `src/app/catalog.ts` and Pi registration lives in `src/pi/register.ts`.

## Orientation block

- **What it does:** lists package surfaces, describes individual surfaces, and reports grouped Pi extension event constants.
- **Commands/tools it registers:** `gentic_surfaces`, `gentic_pi_extension_events`, one `gentic_surface_*` tool per package surface, and `/catalog`, `/surfaces`, `/surface`, `/events` commands.
- **Pi events it listens to:** `session_start` sets a `pi-catalog` status entry with the known surface count.
- **State/config files it reads/writes:** reads compile-time surface/event constants from `src/pi-contract.ts`; writes no state files.
- **Internal module map:** `index.ts` remains the extension entrypoint; `src/pi/register.ts` wires Pi tools/commands/events; `src/app/catalog.ts` formats surfaces, event groups, and command text.
- **Tests to run:** `npm test -- test/gentic-demo.test.ts` or the full `npm test` suite.
- **Known boundaries/non-goals:** this extension documents and exposes Pi contract surfaces; scaffolding templates remain owned by `extensions/pi-catalog/templates/` and separate scaffold commands.

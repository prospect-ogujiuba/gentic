# pi-hud

Visiplane-style HUD for Gentic, implemented as a clean Pi extension.

It copies the Visiplane component design: multi-line responsive footer, context bar, provider/model/thinking display, git/worktree status, tool badges/summary, recent harness events, work timer, and a framed overlay modal.

## Anatomy

- **Mode:** `layered`
- **State:** `layered-lite`
- **Public entry:** `index.ts`
- **Layers:** `pi`, `app`, `domain`, `ui`
- **Machine declaration:** `extension.anatomy.json`
- **Reference role:** targeted behavior-preserving declaration; `index.ts` is a thin public entrypoint delegating to `src/pi/register.ts`.
- **Layer notes:** Pi adapter/register glue lives under `src/pi/`. Snapshot, state, and git orchestration live under `src/app/`, with pure git status normalization in `src/domain/`. HUD rendering surfaces, components, and formatting helpers live under `src/ui/`; shared contracts remain in root `types.ts` as an intentional `layered-lite` seam.

## Commands

- `/pi-hud` / `/pi-hud open` / `/pi-hud modal` — open the HUD modal
- `/pi-hud show` / `/pi-hud hide`
- `/pi-hud placement footer|widget|both`
- `/pi-hud toggle provider|model|context|git|session|tools|events|worktime`
- `/pi-hud only <component>`
- `/pi-hud reset`

Each HUD component can be independently enabled or disabled while retaining the Visiplane layout style.

## Module map

- `index.ts` is the thin Pi extension public entrypoint.
- `src/pi/register.ts` owns extension registration orchestration.
- `src/pi/adapter.ts` owns `/pi-hud` command parsing, harness event mapping, and HUD refresh side effects so the entrypoint does not become a parsing/mapping dumping ground.
- `src/app/state.ts` owns HUD app state, config guards, usage aggregation, and work timer selectors.
- `src/app/snapshot.ts` owns snapshot assembly from Pi context, HUD state, live usage, and git status.
- `src/app/git-status.ts` owns git process calls; `src/domain/git-status.ts` owns pure porcelain/upstream normalization.
- `src/ui/components/`, `src/ui/surfaces/`, and `src/ui/lib/format.ts` own HUD rendering, footer/modal surfaces, and UI formatting helpers.
- `types.ts` retains shared cross-layer contracts as the remaining root-level layer seam.

## Contributor orientation

Start at `index.ts` only to find the public Pi extension entrypoint. Put Pi API registration, command parsing, event mapping, and UI side effects in `src/pi/`; put snapshot assembly, config/state, timers, usage aggregation, and git process calls in `src/app/`; keep pure normalization in `src/domain/`; and keep rendering, surfaces, and ANSI-aware formatting in `src/ui/`.

The current `layered-lite` state is behavior-preserving rather than fully pure layered architecture: `types.ts` is still shared at the extension root, and some UI helpers read HUD state directly for tool/worktime/footer/modal output. Treat those as deferred architecture questions, not as reasons to add new root-level implementation files.

## Verification

- `npm run check` validates Pi extension API usage and extension anatomy/resource placement.
- `node --experimental-strip-types --test test/pi-hud-usage.test.ts test/pi-context-hud-adapter.test.ts` covers representative pi-hud usage accounting, footer output, and pi-context HUD adapter behavior.

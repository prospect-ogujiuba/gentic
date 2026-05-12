# pi-hud

Visiplane-style HUD for Gentic, implemented as a clean Pi extension.

It copies the Visiplane component design: multi-line responsive footer, context bar, model/thinking display, git/worktree status, tool badges/summary, recent harness events, work timer, and a framed overlay modal.

## Anatomy

- **Mode:** `layered`
- **State:** `transitional`
- **Public entry:** `index.ts`
- **Layers:** `pi`, `app`, `ui`
- **Machine declaration:** `extension.anatomy.json`
- **Reference role:** targeted behavior-preserving declaration; `index.ts` is already a thin adapter.
- **Mismatch notes:** layer roles are not yet folderized. `adapter.ts` wires Pi commands/events, `state.ts`/`snapshot.ts`/`git.ts` hold app/data responsibilities, and `components/` plus `surfaces/` hold UI rendering.

## Commands

- `/pi-hud` / `/pi-hud open` / `/pi-hud modal` — open the HUD modal
- `/pi-hud show` / `/pi-hud hide`
- `/pi-hud placement footer|widget|both`
- `/pi-hud toggle model|context|git|session|tools|events|worktime`
- `/pi-hud only <component>`
- `/pi-hud reset`

Each HUD component can be independently enabled or disabled while retaining the Visiplane layout style.

## Module map

- `index.ts` is the thin Pi extension entrypoint.
- `adapter.ts` owns `/pi-hud` command parsing, harness event mapping, and HUD refresh side effects so the entrypoint does not become a parsing/mapping dumping ground.
- `state.ts`, `snapshot.ts`, `components/`, and `surfaces/` retain HUD state, data collection, rendering, footer, and modal responsibilities.

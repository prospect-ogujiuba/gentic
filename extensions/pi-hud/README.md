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

- `/pi-hud` / `/pi-hud open` / `/pi-hud modal` — open the on-demand HUD modal in TUI mode
- `/pi-hud mode off|widget-first|footer`
- `/pi-hud show` / `/pi-hud hide` — compatibility aliases for `widget-first` / `off`
- `/pi-hud placement footer|widget|both` — legacy alias; `widget` and `both` migrate to `widget-first`
- `/pi-hud toggle provider|model|context|git|session|tools|events|worktime`
- `/pi-hud only <component>`
- `/pi-hud reset`

Each HUD component can be independently enabled or disabled while retaining the Visiplane layout style.

## Display configuration

`displayMode` is typed as `off | widget-first | footer`. The default and reset value is `widget-first`, which leaves Pi's native footer visible. `footer` is the only mode that replaces the native footer and must be explicitly selected. The modal is an on-demand TUI command, not a persistent display mode.

Configuration resolution is strict: absent configuration uses `widget-first`; invalid values throw `TypeError`. Legacy `{ enabled, placement }` values migrate as follows:

| Legacy value | Display mode |
|---|---|
| `enabled: false` | `off` |
| `placement: widget` | `widget-first` |
| `placement: both` | `widget-first` (native footer wins the conflict) |
| `placement: footer` | `footer` |

## UI ownership and cleanup

| Surface | Owner / conflict policy | Cleanup path |
|---|---|---|
| Native footer | Pi owns it in `off`, `widget-first`, and modal use. `footer` explicitly transfers ownership to pi-hud. | pi-hud calls `setFooter(undefined)` before changing TUI mode and on shutdown. |
| HUD widget | pi-hud owns only widget id `pi-hud`; it does not overwrite other widget ids. | pi-hud calls `setWidget("pi-hud", undefined)` before refresh/mode changes and on TUI/RPC shutdown. |
| Status entries | Pi and other extensions retain ownership; pi-hud does not set or clear status keys. | No pi-hud cleanup is required. |
| Working message/indicator | Pi retains ownership; pi-hud never changes working visibility, message, or indicator. | No pi-hud cleanup is required. |
| Modal | pi-hud owns the component only while `/pi-hud open` is active in TUI mode. | `custom()` completion disposes the component and clears `state.modal` in `finally`. |

## Runtime mode matrix

| `ctx.mode` | `off` | `widget-first` | `footer` | On-demand modal |
|---|---|---|---|---|
| `tui` | Clear pi-hud footer/widget ownership. | Component factory in widget `pi-hud`; native footer remains. | Component factory replaces footer; widget is cleared. | Supported through `custom()`. |
| `rpc` | Clear widget `pi-hud`. | Fire-and-forget `setWidget` with rendered string lines. | Same safe widget projection; `setFooter` is unsupported and is never called. | Unsupported; `custom()` is never called. |
| `json` | No custom UI calls. | No custom UI calls. | No custom UI calls. | Unsupported. |
| `print` | No custom UI calls. | No custom UI calls. | No custom UI calls. | Unsupported. |

Component factories and `custom()` are gated by `ctx.mode === "tui"`. RPC receives only the supported string-array widget request; JSON and print modes invoke no pi-hud UI methods.

## Git snapshot service

HUD render and event paths read Git state from an O(1), single-slot cache and never launch synchronous processes. Observed HUD events request an asynchronous refresh; requests within a burst share one promise and one collector. The default burst debounce is 25 ms and a successful value remains fresh for 1,000 ms.

The service exposes `loading`, `fresh`, `stale`, `unavailable`, and `error` states while `HudSnapshot.git` remains the last-good render-compatible value. A command error keeps that last-good value marked stale; a non-repository result is unavailable and has no valid Git fields. Session reset/shutdown increments the generation, clears debounce timers, aborts the active collector, and prevents late results from publishing.

Collection uses sequential asynchronous Git commands under one 800 ms total deadline and a 64 KiB decreasing output budget. Error detail is capped, and retries require another observed refresh signal; there is no background polling.

## Module map

- `index.ts` is the thin Pi extension public entrypoint.
- `src/pi/register.ts` owns extension registration orchestration.
- `src/pi/adapter.ts` owns `/pi-hud` command parsing, harness event mapping, and HUD refresh side effects so the entrypoint does not become a parsing/mapping dumping ground.
- `src/app/state.ts` owns HUD app state, config guards, usage aggregation, and work timer selectors.
- `src/app/snapshot.ts` owns synchronous cache-only snapshot assembly from Pi context, HUD state, live usage, and cached Git state.
- `src/app/git-snapshot-service.ts` owns generation ordering, single-flight refresh, debounce, freshness, cancellation, and last-good state.
- `src/app/git-status.ts` owns bounded asynchronous Git process calls; `src/domain/git-status.ts` owns pure porcelain/upstream normalization.
- `src/ui/components/`, `src/ui/surfaces/`, and `src/ui/lib/format.ts` own HUD rendering, footer/modal surfaces, and UI formatting helpers.
- `types.ts` retains shared cross-layer contracts as the remaining root-level layer seam.

## Contributor orientation

Start at `index.ts` only to find the public Pi extension entrypoint. Put Pi API registration, command parsing, event mapping, and UI side effects in `src/pi/`; put snapshot assembly, config/state, timers, usage aggregation, and git process calls in `src/app/`; keep pure normalization in `src/domain/`; and keep rendering, surfaces, and ANSI-aware formatting in `src/ui/`.

The current `layered-lite` state is behavior-preserving rather than fully pure layered architecture: `types.ts` is still shared at the extension root, and some UI helpers read HUD state directly for tool/worktime/footer/modal output. Treat those as deferred architecture questions, not as reasons to add new root-level implementation files.

## Verification

- `npm run check` validates Pi extension API usage and extension anatomy/resource placement.
- `node --experimental-strip-types --test test/pi-hud-snapshot-service.test.ts test/pi-hud-mode-contract.test.ts test/pi-hud-usage.test.ts test/pi-context-hud-adapter.test.ts` covers async Git bounds, generation/cancellation, coalescing/debounce, display routing, representative pi-hud usage accounting, footer output, and pi-context HUD adapter behavior.

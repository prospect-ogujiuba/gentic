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
| Native footer | Pi owns it in `off`, `widget-first`, and modal use. `footer` explicitly transfers rendering to pi-hud while consuming Pi's `footerData` branch and extension statuses. | pi-hud calls `setFooter(undefined)` before changing TUI mode and on shutdown; the footer component unsubscribes `onBranchChange()` in idempotent disposal. |
| HUD widget | pi-hud owns only widget id `pi-hud`; it does not overwrite other widget ids. | pi-hud calls `setWidget("pi-hud", undefined)` before refresh/mode changes and on TUI/RPC shutdown. |
| Status entries | Pi and other extensions retain their status keys. The native footer displays them in default mode; footer replacement renders equivalent `getExtensionStatuses()` values without mutating keys. pi-hud reserves only key `pi-hud`. | Session cleanup clears only `setStatus("pi-hud", undefined)`; other extension keys are untouched. |
| Working message/indicator | Pi retains ownership; pi-hud never changes working visibility, message, or indicator. | No pi-hud cleanup is required. |
| Modal | The runtime owner holds exactly one component only while `/pi-hud open` is active in TUI mode. | Close, replacement, `custom()` completion, session shutdown, and partial failure all call idempotent disposal and discard the reference. |

## Runtime mode matrix

| `ctx.mode` | `off` | `widget-first` | `footer` | On-demand modal |
|---|---|---|---|---|
| `tui` | Clear pi-hud footer/widget ownership. | Component factory in widget `pi-hud`; native footer and extension statuses remain. | Component factory replaces the footer, reads `getGitBranch()`/`getExtensionStatuses()`, subscribes once with `onBranchChange()`, and clears the widget. | Supported through `custom()` with a fresh component per opening. |
| `rpc` | Clear widget `pi-hud`. | Fire-and-forget `setWidget` with rendered string lines. | Same safe widget projection; `setFooter` is unsupported and is never called. | Unsupported; `custom()` is never called. |
| `json` | No custom UI calls. | No custom UI calls. | No custom UI calls. | Unsupported. |
| `print` | No custom UI calls. | No custom UI calls. | No custom UI calls. | Unsupported. |

Component factories and `custom()` are gated by `ctx.mode === "tui"`. RPC receives only the supported string-array widget request; JSON and print modes invoke no pi-hud UI methods.

## Responsive rendering

Every returned line is finally truncated with Pi's ANSI-aware width helpers, so its visible width never exceeds the supplied width. Ordering is deterministic:

- **Narrow (`<48`)**: omit the decorative recent-events line; retain model, Git/worktree, active-tool count, errors, and warnings. Tool badges and completion detail yield before active/error state.
- **Medium (`48–79`)**: restore recent events, compact context/Git detail, and keep only the highest-priority tool badges or native statuses that fit.
- **Wide (`>=80`)**: render full component candidates, all fitting native statuses, and left/right alignment.
- **Footer native line**: below 24 columns, preserve the first non-empty extension status (or branch when no status exists); from 24 columns upward, preserve a bounded branch segment plus status summary, omitting later statuses as `+N` before truncating high-priority content.

Render calls are pure with respect to processes, timers, and subscriptions. Surface factories own the optional one-second render timer; footer construction owns exactly one branch subscription, and disposal clears both. Modal construction remains on-demand, TUI-only, and fresh per opening.

## Lifecycle and disposal

`src/pi/runtime.ts` is the single session runtime owner. `session_start` first tears down any still-active generation, resets all HUD state/configuration, and starts a new snapshot generation. `session_shutdown` is idempotent: it marks the generation inactive before clearing the modal, footer, widget, reserved status key, surface timers/subscriptions through Pi component disposal, work timer/state, debounce work, abort controller, and cached snapshot state.

Pi exposes reload and replacement through lifecycle reasons rather than a separate extension-reload hook: `session_shutdown` reports `reload | new | resume | fork`, then the rebound extension receives `session_start` with `reload | new | resume | fork`; clone is represented as `fork`. The runtime also refreshes through Phase 5.2 coalescing on `agent_settled` and `session_info_changed`. A captured runtime generation plus snapshot generation prevents late completions from applying after shutdown or replacement.

Extension factories start no resources. Surface timers/subscriptions begin only when Pi instantiates a component; modal timers begin only on an actual TUI opening. Cleanup before initialization is a no-op, cleanup operations are individually guarded after partial setup, and repeated cleanup does not repeat UI or disposal side effects.

## Git snapshot service

HUD render and event paths read Git state from an O(1), single-slot cache and never launch synchronous processes. Observed HUD events request an asynchronous refresh; requests within a burst share one promise and one collector. The default burst debounce is 25 ms and a successful value remains fresh for 1,000 ms.

The service exposes `loading`, `fresh`, `stale`, `unavailable`, and `error` states while `HudSnapshot.git` remains the last-good render-compatible value. A command error keeps that last-good value marked stale; a non-repository result is unavailable and has no valid Git fields. Session reset/shutdown increments the generation, clears debounce timers, aborts the active collector, and prevents late results from publishing.

Collection uses sequential asynchronous Git commands under one 800 ms total deadline and a 64 KiB decreasing output budget. Error detail is capped, and retries require another observed refresh signal; there is no background polling.

## Module map

- `index.ts` is the thin Pi extension public entrypoint.
- `src/pi/register.ts` owns extension registration orchestration.
- `src/pi/adapter.ts` owns `/pi-hud` command parsing and harness event mapping so the entrypoint does not become a parsing/mapping dumping ground.
- `src/pi/runtime.ts` centrally owns session generations, surface application/cleanup, modal identity, and snapshot refresh publication.
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
- `node --experimental-strip-types --test test/pi-hud-lifecycle.test.ts test/pi-hud-responsive-rendering.test.ts test/pi-hud-snapshot-service.test.ts test/pi-hud-mode-contract.test.ts test/pi-hud-usage.test.ts test/pi-context-hud-adapter.test.ts` covers repeated reload/new/resume/fork/clone lifecycle, idempotent and partial-failure cleanup, late generation rejection, modal reopen/disposal, responsive rendering, async Git bounds, display routing, usage accounting, and pi-context HUD behavior.

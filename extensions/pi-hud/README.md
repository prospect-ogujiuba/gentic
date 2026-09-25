# pi-hud

A compact, optional Pi widget. Pi's native footer remains authoritative.

## Surface

The widget presents four text-labeled groups in stable priority order:

1. active model;
2. bounded context pressure from pi-context's native snapshot adapter;
3. cached Git summary;
4. current coarse activity.

Color is supplementary. Medium and wide layouts retain the 16-cell context bar, used/window tokens, remaining percentage, and rich Git detail (`branch(*) · remote · synced · ↓/↑ · working-tree counts`). Narrow layouts compact these into stable labeled groups. Rendering is pure, ANSI-aware, width-bounded, and timer-free.

## Commands

- `/pi-hud` or `/pi-hud show` — show the widget
- `/pi-hud hide` — hide the widget
- `/pi-hud reset` — restore `widget-first`
- `/pi-hud mode off|widget-first`

Root and mode completions preserve the full argument prefix, and invalid-input usage is rendered from the same local action metadata. Legacy migration parsing and display-mode execution remain owned by pi-hud.

The widget is registered only under id `pi-hud`. JSON and print modes make no UI calls; RPC receives width-bounded string lines.

## Migration

Legacy `footer`, `widget`, and `both` display/placement values migrate to `widget-first`. Legacy `/pi-hud open`, `/pi-hud modal`, and `/pi-hud placement ...` commands also show the widget and report that migration. This preserves a non-disruptive display path without taking ownership of Pi's footer. Rolling back the code remains safe because no persisted configuration is rewritten.

The former footer replacement, modal, component toggle matrix, work timer, event history, usage ledger, and their rendering modules have been removed.

## Refresh and ownership

`src/pi/runtime.ts` owns one session generation and the `pi-hud` widget. Native model, context usage, and coarse activity are projected into an on-demand bounded snapshot. Live context projection reads native usage once, fails closed when unavailable, and skips prompt/branch contributor scans. The local context adapter consumes pi-context's public entrypoint for pressure policy loading and bounded HUD snapshots; it does not inspect prompt, branch, or tool content.

Git collection is event-driven, asynchronous, and single-flight. The HUD consumes `collectGitSnapshot` and its typed contract from pi-git's public entrypoint, while pi-git owns commands, bounded process execution, process deadlines, output limits, and process-group cleanup. HUD-local orchestration applies an 800 ms response deadline through the provider's cancellation signal, maps bounded or timed-out provider results into display state, and negatively caches unavailable/error results for one second to prevent provider storms. Session reset bypasses that cache. There is no interval or background polling loop, and widget rendering itself starts no timers or subscriptions.

Shutdown clears only widget id `pi-hud`, cancels pending Git work, and rejects late generation results. Pi's native footer, working indicator, statuses, editor, and other widgets remain untouched.

## Verification

- `node --experimental-strip-types --test test/pi-hud*.test.ts test/pi-context-hud-adapter.test.ts`
- `npm run typecheck`
- `npm run check:dependencies`
- `npm run check:performance`

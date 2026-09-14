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

The widget is registered only under id `pi-hud`. JSON and print modes make no UI calls; RPC receives width-bounded string lines.

## Migration

Legacy `footer`, `widget`, and `both` display/placement values migrate to `widget-first`. Legacy `/pi-hud open`, `/pi-hud modal`, and `/pi-hud placement ...` commands also show the widget and report that migration. This preserves a non-disruptive display path without taking ownership of Pi's footer. Rolling back the code remains safe because no persisted configuration is rewritten.

The former footer replacement, modal, component toggle matrix, work timer, event history, usage ledger, and their rendering modules have been removed.

## Refresh and ownership

`src/pi/runtime.ts` owns one session generation and the `pi-hud` widget. Native model, context usage, session branch data, and coarse activity are projected into an on-demand bounded snapshot. Git collection is event-driven, asynchronous, single-flight, deadline/output-bounded, and has no interval or background polling loop. Widget rendering itself starts no timers or subscriptions.

Shutdown clears only widget id `pi-hud`, cancels pending Git work, and rejects late generation results. Pi's native footer, working indicator, statuses, editor, and other widgets remain untouched.

## Verification

- `node --experimental-strip-types --test test/pi-hud*.test.ts test/pi-context-hud-adapter.test.ts`
- `npm run typecheck`
- `npm run check:performance`

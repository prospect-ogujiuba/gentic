# Minimum pi-hud widget surface

## Dependency gate

Implementation may proceed because `.model-artifacts/initiatives/lighten-pi-context/workflow.json` is `complete` and all of its tasks are complete. pi-hud consumes its lightweight, bounded HUD adapter; it does not recreate a context ledger.

## Surface and ownership

pi-hud owns one optional widget, registered only under the `pi-hud` widget id. Users can turn that widget on or off. Pi's native footer remains visible and authoritative for native status, mode, and extension feedback; pi-hud never replaces or duplicates it.

The widget contains exactly four information groups, in this priority order:

1. **Model** — the active model's concise display identifier.
2. **Context pressure** — a textual pressure state plus the compact visual context bar, used/window tokens, and bounded percentage/remaining capacity when available from pi-context.
3. **Git summary** — concise but rich branch, remote/sync, ahead/behind, and staged/unstaged/untracked state from Pi-native or shared bounded state.
4. **Activity** — the current coarse activity state, such as `idle`, `thinking`, or an active tool category; no history is retained.

Unavailable values use a short explicit marker such as `unknown` or `unavailable`; stale Git data is labeled `stale`. Errors degrade the affected group without hiding the other groups or emitting repeated notifications.

## Terminal and accessibility behavior

- Model and context pressure appear before lower-priority Git and activity detail.
- Every state has a text label or symbol-plus-label; color is supplementary and never the only signal.
- Narrow terminals compact or omit detail rather than wrap, overwrite input, or obscure Pi's native footer.
- Updates preserve stable group order to reduce visual movement and do not steal focus.
- The widget introduces no modal, focus trap, or required pointer interaction. Existing Pi command entry and keyboard behavior remain unchanged.
- Turning the widget off clears only the `pi-hud` widget and provides concise command feedback through Pi's normal command/status path.

## Explicit exclusions

This scope excludes:

- a custom footer or any call that replaces Pi's native footer;
- modal or overlay UI;
- work timers;
- event or tool history;
- a component toggle matrix or multiple HUD surfaces;
- an independent Git polling service;
- a parallel context, tool-execution, or streaming-update ledger.

These exclusions are deletion targets for later workflow tasks, not compatibility requirements for the rebuilt widget.

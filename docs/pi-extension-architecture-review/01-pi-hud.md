# 1. `pi-hud` — worst architecture

> Shared review context: [overall verdict, comparison table, and priority order](./README.md).

## Verdict

**Poorly designed**

## Findings

`pi-hud` directly imports private implementation files from sibling extensions:

- `extensions/pi-hud/src/app/git-status.ts:1` imports `pi-git/src/app/snapshot.ts`
- `extensions/pi-hud/src/app/snapshot.ts` imports `pi-context/src/app/index.ts`
- `extensions/pi-hud/src/pi/runtime.ts` imports `pi-context/src/config/index.ts`

That destroys extension independence. Refactoring or disabling `pi-git` or `pi-context` can break HUD compilation even though no public contract changed. The full profile merely hides this coupling.

It also coordinates:

- Git subprocesses
- context state
- model state
- activity state
- caching
- lifecycle generation
- rendering
- twelve files
- nine event hooks

That is an integration subsystem disguised as a status widget.

## Recommended fix

Extract stable shared APIs into core modules, or make HUD consume explicit providers.

**Do not import another extension's `src/` tree.**

## Related priorities

This maps directly to priority **#1** in the [shared priority order](./README.md#priority-order).

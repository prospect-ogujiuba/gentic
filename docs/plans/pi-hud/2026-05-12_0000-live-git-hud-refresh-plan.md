# Live Git HUD Refresh SWE Plan

Created: 2026-05-12
Purpose: Refinement-friendly SWE plan for making the `pi-hud` git component update while Pi is idle.

## 1. Define

**Problem**

`extensions/pi-hud` refreshes git status only when Pi emits session/tool/message/command events. If git state changes while Pi is idle, the HUD can display stale branch/dirty/staged/unstaged/untracked/ahead/behind information.

**User-visible outcome**

The git HUD updates while Pi is idle, so external git changes become visible without requiring agent activity or a manual HUD refresh.

**Constraints**

- Keep scope local to `extensions/pi-hud`.
- Reuse the existing snapshot/render path where possible.
- Avoid frequent expensive git polling.
- Do not create duplicate timers/watchers.
- Clean up all live refresh resources on session shutdown.
- Preserve current event-driven updates.

**Non-goals**

- Redesigning HUD rendering.
- Changing `pi-git` command behavior.
- Adding a broad filesystem watcher across the repo.
- Introducing user-facing configuration in the first slice.
- Changing Pi extension APIs.

## 2. Design

**Affected components**

- `extensions/pi-hud/index.ts`
  - Add live refresh lifecycle helpers.
  - Start refresh from a UI-capable session event.
  - Stop refresh on shutdown.
- `extensions/pi-hud/snapshot.ts`
  - Likely unchanged; already recomputes git state via `getGitStatus(ctx.cwd)`.
- `extensions/pi-hud/git.ts`
  - Likely unchanged; already gathers branch/status/upstream data with bounded git calls.
- Tests
  - Add focused coverage for idle refresh and cleanup.

**Data/control flow**

1. Existing event handlers continue to call `recordEvent(ctx, event.type)`.
2. `recordEvent` continues to call `applyHud(ctx)` when UI is available.
3. New live refresh stores the latest UI-capable `ExtensionContext`.
4. A single interval periodically calls the existing `applyHud(ctx)` path.
5. `applyHud(ctx)` rebuilds a snapshot, including fresh git status, and updates footer/widget/modal.
6. `session_shutdown` clears the interval and removes HUD surfaces.

**Refresh policy**

Initial slice should use simple polling, not file watching:

- Interval cadence: start with about `3000ms`.
- Only refresh when:
  - `ctx.hasUI` is true,
  - `state.enabled` is true,
  - `state.components.git` is true,
  - placement is `footer`, `widget`, or `both`.
- Ensure interval creation is idempotent.

**Risks**

- Polling may run too many `git` commands in large repositories.
- Holding an old context could be wrong if cwd/session changes.
- UI updates while hidden could waste work or cause flicker.
- Fake timers may be needed for deterministic tests.

**Unknowns**

- Whether Pi offers a preferred idle render/timer API.
- Whether a future `.git` watcher would be lower overhead than polling.
- Whether refresh cadence should become configurable after proving value.

## 3. Slice

Smallest honest vertical slice:

1. Add `startLiveGitRefresh(ctx)` and `stopLiveGitRefresh()` in `extensions/pi-hud/index.ts`.
2. Start refresh on `session_start` when `ctx.hasUI`.
3. Update the stored context on subsequent UI-capable events.
4. On each interval tick, call `applyHud(ctx)` only when HUD and git component are enabled.
5. Stop refresh on `session_shutdown`.
6. Add tests that prove idle interval refresh updates the HUD and shutdown clears the interval.

Defer:

- Configurable interval.
- Git state diffing before render.
- Filesystem watching.
- New `/pi-hud` command options.

## 4. Definition of Done

- Git HUD refreshes while Pi is idle after external git changes.
- Existing event-driven HUD updates still work.
- Only one live refresh interval can exist per session.
- Refresh does not run when HUD is disabled or git component is hidden.
- `session_shutdown` clears the interval and removes footer/widget HUD surfaces.
- Tests cover interval refresh and cleanup.
- No changes outside the narrow `pi-hud` implementation/test scope unless required by existing test harness constraints.

## 5. Verification Plan

**Automated checks**

- `npm test`
- `npm run check`

**Focused test evidence**

Add or adjust a test harness to verify:

- Emitting `session_start` renders HUD and starts live refresh.
- Advancing the refresh interval causes another HUD render without any new Pi event.
- Disabling or hiding the git component prevents refresh work.
- Emitting `session_shutdown` clears the interval and clears footer/widget surfaces.

**Manual smoke check**

1. Start Pi with `pi-hud` visible.
2. Let Pi sit idle.
3. From another terminal, create an untracked file, stage a file, and change branch or dirty state.
4. Confirm the git HUD updates within the refresh interval without agent/tool activity.
5. Shutdown Pi and confirm no lingering refresh activity/errors.

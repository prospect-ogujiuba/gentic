# pi-hud

Visiplane-style HUD for Gentic, implemented as a clean Pi extension.

It copies the Visiplane component design: multi-line responsive footer, context bar, model/thinking display, git/worktree status, tool badges/summary, recent harness events, work timer, and a framed overlay modal.

## Commands

- `/pi-hud` / `/pi-hud open` / `/pi-hud modal` — open the HUD modal
- `/pi-hud show` / `/pi-hud hide`
- `/pi-hud placement footer|widget|both`
- `/pi-hud toggle model|context|git|session|tools|events|worktime`
- `/pi-hud only <component>`
- `/pi-hud reset`

Each HUD component can be independently enabled or disabled while retaining the Visiplane layout style.

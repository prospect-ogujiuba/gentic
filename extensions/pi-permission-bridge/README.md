# pi-permission-bridge

`pi-permission-bridge` preserves permission enforcement for Pi's `user_bash` event while `@gotgenes/pi-permission-system` owns the policy engine and all model-callable tool gates.

## Orientation block

- **What it does:** resolves the current session's published permission service, asynchronously parses user-entered bash before every decision, composes command-pattern, path, and external-directory surfaces most-restrictive, structurally denies destructive root/home removal, and fails closed when analysis, service, UI, or confirmation is unavailable.
- **Commands/tools it registers:** none.
- **Pi events it listens to:** `permissions:ready` on the extension event bus plus `user_bash` and `session_shutdown` lifecycle events.
- **State/config files it reads/writes:** reads global and trusted-project `permissionReviewLog` settings; when enabled, appends owner-only (`0600`) redacted `user_bash` records to the provider's `logs/pi-permission-system-permission-review.jsonl` (command length + SHA-256, never raw command text).
- **Tests to run:** `node --experimental-strip-types --test test/pi-permission-bridge.test.ts`.
- **Known boundaries/non-goals:** this is not a second policy engine and does not persist decisions. It uses pinned `@gotgenes/pi-permission-system` parser/path internals because the public service exposes only synchronous advisory bash checks; the exact dependency pin and integration tests guard that adapter. `ask` requires two confirmations and fails closed outside TUI/RPC modes. Bridge approvals intentionally cannot create provider session approvals; each user-entered command remains independently confirmed.

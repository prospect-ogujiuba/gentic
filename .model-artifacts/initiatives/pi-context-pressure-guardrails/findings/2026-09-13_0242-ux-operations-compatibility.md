# UX, operations, security, and compatibility finding: Context-pressure guardrails

- Topic: `pi-context-pressure-guardrails`
- Reviewed spec: revision 1, `.model-artifacts/initiatives/pi-context-pressure-guardrails/specs/2026-09-13_0242-initiative-spec-r1.md`
- Reviewed plan: revision 1, `.model-artifacts/initiatives/pi-context-pressure-guardrails/plans/2026-09-13_0242-plan-index-r1.md`
- Disposition: incorporate

## Accessibility and UX

Use plain labels (`normal`, `warning`, `critical`) and notification severity, never color alone. Include remaining percentage and a concise suggested response. Notify only on transitions; command/HUD status remains available without notification.

## Operations

Use no background timer. Evaluate on existing usage-bearing hooks, inject time for cooldown tests, bound diagnostics, and clear ephemeral transition state on session reset/shutdown. Compaction refreshes measured state rather than being treated as an alert.

## Security and privacy

Store and render numeric usage, level, policy source, and bounded diagnostics only. Never add prompts, tool arguments/results, content previews, credentials, or paths to pressure state or notifications. No external calls or automatic actions.

## Compatibility and migration

Keep existing commands and report/HUD fields. Add optional fields only. Support absent config with defaults; project overrides global field-by-field. Reject unknown schema versions and invalid threshold ordering to safe defaults with diagnostics. No persisted ledger migration.

## Performance

The evaluator must remain O(1) per hook and add no filesystem work after config load. Existing bounded retention limits remain unchanged.

## Verification

Fake-UI severity assertions, no-color text checks, repeated lifecycle/disposal tests, privacy assertions on JSON/HUD output, invalid/future config cases, and existing snapshot compatibility tests.

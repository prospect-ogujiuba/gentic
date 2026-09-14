# Pi primitives full-review audit findings

Baseline: `npm run test:primitives` passes 17/17 and `npm run typecheck` passes. The audit traced explicit registration, all four registry entries, configuration, session status, the three prompt-policy hooks, recursive trigger flattening, prompt bounds, README claims, and generated inventory.

## Reproduced defects

1. **Configuration accepts invalid top-level and `enabled` values.** Arrays, numbers, and strings parse without a diagnostic, and `{ "enabled": "false" }` is silently treated as enabled. Configuration should be a JSON object and `enabled` should be boolean when present.
2. **Global disablement hides disabled status data.** `{ "enabled": false }` returns empty `loaded`, `skipped`, and `failures`, so session status says only `0 loaded` although every explicit primitive was disabled. This conflicts with the documented loaded/disabled status contract.
3. **Primitive resource containment is lexical only.** A symlink inside a primitive directory can make `ctx.readText("link")` read a file outside that directory, despite README describing the helper as safe/local.
4. **Empty trigger definitions match every request.** `phrases: [""]` and `pathPatterns: [""]` both activate on unrelated input. Blank trigger entries should fail primitive registration rather than turn a conditional policy into an always-on policy.
5. **Policy duplicate detection uses substring matching.** Any prose containing the first heading suppresses injection, even when the policy heading is not present as a line. Idempotence should recognize an exact heading line.

## Preserved decisions and non-issues

- `whimsical` intentionally remains an enabled/disabled no-op registry entry for configuration and report compatibility; it must not register turn hooks.
- Trigger input fails closed as designed for over-budget, cyclic, too-deep, accessor-bearing, proxy-throwing, or otherwise unreadable structures.
- Shared non-cyclic references are accepted, and node/character budgets include exact boundaries.
- Static import resolution failures remain extension startup failures by design; initializer failures remain isolated and reported.
- Bundled policy content is never derived from or interpolated with trigger input.

The reproduced defects will be converted to adversarial regression tests before implementation fixes.
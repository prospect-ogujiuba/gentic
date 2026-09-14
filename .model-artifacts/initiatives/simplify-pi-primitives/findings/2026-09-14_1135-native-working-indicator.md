# T4 native working indicator

Removed the whimsical message catalog, random selection, and turn-start/turn-end working-message overrides. Native Pi working feedback is left untouched. The existing default export and explicit registry entry remain as a no-op for config/report compatibility. No loader or prompt-injection changes belong to this task.

## Same-method performance comparison

Measured UTF-8 source bytes, `pi.on(` occurrences, and message literal lines in the same file before and after:

| Measurement | Before | After |
| --- | ---: | ---: |
| Source bytes | 11900 | 209 |
| Registered turn hooks | 2 | 0 |
| Inline messages | 454 | 0 |

No wall-clock speedup is claimed. The catalog allocation and per-turn random-selection/reset work are eliminated.

## Migration and rollback

The primitive name remains accepted in `config.json` and remains loaded or skipped in reports as before. A regression test exercises both enabled and disabled configurations and asserts only the three prompt-policy hooks are registered, with no competing working-message hooks. Native rendering itself was not manually exercised in a live TUI.

Restart an idle session after upgrading to discard old registered handlers and any outstanding UI override. No user data changes. Rollback restores only the prior whimsical module and restarts the session; do not load old and new implementations together. README documents this operator path.

## Objective checks

The new compatibility test failed against the old two-hook implementation before replacement. Final verification uses `npm run test:primitives` and `npm run typecheck` through the protected bash tool, with workflow evidence bound after each check.

# primitive template

`/scaffold primitive <name> --apply` creates `index.ts`, `injection.md`, and `triggers.json` beneath `extensions/pi-primitives/primitives/<name>/`. The entrypoint is a native Pi extension using explicit file reads and the retained bounded prompt-policy and trigger helpers.

Creation does not load the extension. Add its `index.ts` path to native Pi extension settings or use `pi --extension <path>`. Run focused tests, then `/reload` Pi. Do not modify the fixed built-in policy bundle; its former internal registry has been retired.

# primitive template

`/scaffold primitive <name> --apply` creates `index.ts`, `injection.md`, and `triggers.json` beneath `extensions/pi-primitives/primitives/<name>/`. The entrypoint uses the host's bounded prompt-policy and trigger helpers.

Creation does not register the primitive. Import its default export in `extensions/pi-primitives/index.ts`, add one definition to `EXPLICIT_PRIMITIVES`, run the focused tests, then `/reload` Pi.

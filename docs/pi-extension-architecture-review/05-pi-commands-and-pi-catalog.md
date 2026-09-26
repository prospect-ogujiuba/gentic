# 5. `pi-commands` + `pi-catalog` — inverted ownership

> Shared review context: [overall verdict, comparison table, and priority order](./README.md).

## Verdict

- `pi-commands`: **Mixed; scaffolder boundary is bad**
- `pi-catalog`: **Mixed; confused ownership**

## Resolution

Templates now live beside their consumer in `extensions/pi-commands/templates/`. The public command remains in `commands/scaffold.ts`; `scaffold/planning.ts`, `scaffold/rendering.ts`, and `scaffold/application.ts` separate planning, rendering, and transactional writes. `pi-catalog` remains runtime discovery only. Golden previews and applied-tree tests preserve every supported kind, including primitive.

## Original findings (historical)

The scaffolder lives in:

```text
extensions/pi-commands/commands/scaffold.ts
```

Its templates originally lived inside the unrelated runtime-discovery extension, with a hard-coded cross-extension filesystem dependency.

The original `scaffold.ts` was a 374-line module that combined:

- argument parsing
- kind definitions
- template selection
- rendering
- project discovery
- path security
- staging
- commit
- rollback
- formatting
- completions

Meanwhile, `pi-catalog` claims to be a catalog but primarily exposes runtime command/tool discovery. Housing a large template warehouse further muddles its purpose.

## Recommended fix

Move templates:

- beside the scaffolder, or
- into a dedicated scaffolding package

Then split the scaffolder into distinct concerns:

1. planning
2. rendering
3. transactional application

## Related priorities

This maps directly to priority **#4** in the [shared priority order](./README.md#priority-order).

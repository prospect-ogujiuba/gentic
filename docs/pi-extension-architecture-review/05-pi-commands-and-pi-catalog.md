# 5. `pi-commands` + `pi-catalog` — inverted ownership

> Shared review context: [overall verdict, comparison table, and priority order](./README.md).

## Verdict

- `pi-commands`: **Mixed; scaffolder boundary is bad**
- `pi-catalog`: **Mixed; confused ownership**

## Findings

The scaffolder lives in:

```text
extensions/pi-commands/commands/scaffold.ts
```

Its templates live in:

```text
extensions/pi-catalog/templates/
```

The dependency is hard-coded at `scaffold.ts:46`.

That means the command extension depends on the filesystem internals of an unrelated runtime-discovery extension.

`scaffold.ts` is also a 374-line module that combines:

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

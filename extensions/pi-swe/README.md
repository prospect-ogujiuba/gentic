# pi-swe

A small, opt-in workflow extension for durable multi-step software work. Normal coding needs no workflow.

## Orientation

- **What it does:** stores a goal and dependency-ordered tasks in one file, selects one active task, runs objective verification commands, and advances completed work.
- **Commands/tools:** `/swe status`, `/swe config`, `/swe migrate`, `/swe work`; model-callable `swe_workflow`.
- **Events:** none.
- **State:** `.model-artifacts/initiatives/<topic>/workflow.json` is the sole mutable authority.
- **Modules:** `src/workflow.ts` owns types and the reducer; `src/store.ts` owns bounded atomic persistence and the legacy importer; `src/tool.ts` and `src/command.ts` are Pi adapters.
- **Tests:** `npm run test:swe`; use `npm run typecheck` and `npm run check` for package integration.
- **Non-goals:** no tool-call surveillance, generated reports, per-stage runner, review theater, peer imports, hidden workflows, or multi-file transactions.

## Use

Small tasks should use normal Pi tools. Create a workflow only when work must survive multiple sessions:

```json
{
  "action": "create",
  "topic": "cache-metadata",
  "goal": "Avoid repeated metadata reads",
  "tasks": [
    { "id": "T1", "title": "Add cache behavior", "acceptance": ["Repeated reads hit the cache"] },
    { "id": "T2", "title": "Integrate callers", "dependsOn": ["T1"] }
  ]
}
```

Then use `swe_workflow` actions `start`, `verify`, and `complete`. `verify` executes an argument-vector command directly through Pi—never through a shell—and stores its exit code. Completion requires at least one passing command for the active task.

`/swe work start [topic]` starts the first dependency-ready task and sends one coarse implementation turn. It does not dispatch separate planning, implementation, verification, review, and finalization turns.

## Existing initiatives

When only the former schema-v2 `specs/manifest.json` and `contracts.json` exist, status reads a projection without writing. The first mutation or `/swe migrate <topic>` creates `workflow.json`, preserving executable contract IDs, dependencies, dispositions, active selection, and links to the old plan. Old files remain untouched as history and are never dual-written. Once `workflow.json` exists it is the only authority.

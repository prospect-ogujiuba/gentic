# pi-swe

A small, opt-in workflow extension for durable multi-step software work. Normal coding needs no workflow.

## Orientation

- **What it does:** stores a goal and dependency-ordered tasks in one file, instructs the agent to assess applicable engineering approaches during planning, selects at most one active workflow task per repository, binds protected bash results as verification evidence, and advances completed work.
- **Commands/tools:** `/swe status`, `/swe config`, `/swe migrate`, `/swe work`; model-callable `swe_workflow`.
- **Events:** none.
- **State:** `.model-artifacts/initiatives/<topic>/workflow.json` is the sole mutable authority. The bundled schema describes canonical writes; the runtime explicitly normalizes older version-1 tasks missing assessment fields to `unassessed`.
- **Modules:** `src/workflow.ts` owns types and the reducer; `src/store.ts` owns bounded atomic persistence and the legacy importer; `src/tool.ts` and `src/command.ts` are Pi adapters.
- **Tests:** `npm run test:swe`; use `npm run typecheck` and `npm run check` for package integration.
- **Non-goals:** no global tool-call interception, generated reports, per-stage runner, review theater, peer-extension imports, hidden workflows, or multi-file transactions.

## Use

Small tasks should use normal Pi tools. Create a workflow only when work must survive multiple sessions:

```json
{
  "action": "create",
  "topic": "cache-metadata",
  "goal": "Avoid repeated metadata reads",
  "tasks": [
    {
      "id": "T1",
      "title": "Add cache behavior",
      "approaches": ["tdd", "dsa", "performance"],
      "approachReasons": {
        "tdd": "cache behavior needs regression coverage",
        "dsa": "the representation determines lookup cost",
        "performance": "latency is the reason for the change"
      },
      "acceptance": ["Repeated reads hit the cache"],
      "verification": [{ "command": "npm test", "args": [] }]
    },
    { "id": "T2", "title": "Integrate callers", "dependsOn": ["T1"], "approaches": [] }
  ]
}
```

On `create`, the agent is instructed to assess each task; on `revise`, it reassesses each incomplete task for `tdd`, `diagnosis`, `dsa`, `security`, `performance`, `migration`, `accessibility-ux`, and `operations`. It stores only applicable approaches plus concise reasons; `[]` means none apply. This is advisory and transparent: `/swe status` and `swe_workflow status` show the active assessment, and users can override incomplete-task assessments through `revise`. Applicable concerns are folded into the one coarse execution prompt rather than dispatched as specialists. A material scope or design discovery requires revision and reassessment.

Then use `swe_workflow` actions `start`, `verify`, and `complete`. Every selected approach requires a concise reason. Migrated tasks are explicitly `unassessed`; an imported active selection is paused until revision and resume. Add objective approach-specific checks to `verification` wherever possible.

The verification array is **required-all**, not alternatives:

1. Run each command with Pi's protected `bash` tool.
2. Immediately bind each result in a later tool turn with `verify`.
3. After any potentially mutating tool runs, rerun every planned check.
4. Call `complete` only after the final `verify`.

Evidence must be newer than the task's activation or latest revision timestamp, workflow revision, session, and branch boundary. Completion rejects evidence missing from the active branch, evidence invalidated by a potentially mutating tool result, incomplete planned checks, and a latest result not bound against the immediately preceding workflow revision. After session-tree compaction or a session change, resume the task to establish a new checkpoint before verifying.

Use `revise` with the desired full task graph to add, remove, or update planned work. Completed, active, and blocked tasks cannot be removed; statuses, evidence, evidence links, completion timestamps, and imported provenance are retained for matching tasks.

Every activation path—commands, model-callable start/resume, and automatic advancement—returns the same coarse implementation guidance. It does not dispatch separate planning, implementation, verification, review, and finalization turns.

### pi-todo interoperability

When pi-todo is also enabled, pi-swe is the sole lifecycle authority while an assessed workflow task is active:

- both model-tool and `/swe work` activation reject an already active todo;
- at most one repository workflow may be active;
- pi-todo does not create guard todos for implementation tools during that interval;
- todo inspection and cleanup remain available; and
- creating, starting, reopening, or restructuring todo work is blocked until pi-swe is paused, blocked, or complete.

## Existing initiatives

When only the former schema-v2 `specs/manifest.json` and `contracts.json` exist, status reads a projection without writing. The first mutation or `/swe migrate <topic>` creates `workflow.json`, preserving executable contract IDs, titles, dependencies, dispositions, active selection, acceptance criteria, planned checks, blocker details, evidence links, and completion provenance. Contract authority must be the topic's `.model-artifacts/initiatives/<topic>/plans/revisions/rN` tree. `create` refuses to shadow any legacy manifest and directs callers to migrate. Old files remain untouched as history and are never dual-written. Once `workflow.json` exists it is the only authority.

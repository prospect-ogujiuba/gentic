# pi-swe

A small, opt-in workflow extension for durable multi-step software work. Normal coding needs no workflow.

## Orientation

- **What it does:** stores a goal and dependency-ordered tasks in one file, instructs the agent to assess applicable engineering approaches during planning, selects at most one active workflow task per repository, binds protected bash results as verification evidence, and advances completed work.
- **Commands/tools:** `/swe status`, `/swe config`, `/swe migrate`, `/swe work`; model-callable `swe_workflow`.
- **Events:** the v2 integrity controller defines fail-closed `tool_call`/`tool_result`, user-shell, agent-start, and session-shutdown guards. The installed v1 entrypoint intentionally does not register that controller until a production fenced-orchestration surface is delivered; isolated fixtures exercise it meanwhile. Version-1 compatibility views are always excluded until explicit migration.
- **State:** `.model-artifacts/initiatives/<topic>/workflow.json` is the sole mutable authority. The bundled schema describes canonical writes; the runtime explicitly normalizes older version-1 tasks missing assessment fields to `unassessed`.
- **Modules:** `src/workflow.ts` owns types and the reducer; `src/store.ts` owns bounded atomic persistence and the legacy importer; `src/workspace.ts` owns recoverable Git baselines, detached worktrees, index-preserving integration, and whole-source fingerprints; `src/integrity.ts` owns parent capability and protected-verification authority; `src/tool.ts` and `src/command.ts` are Pi adapters.
- **Tests:** `npm run test:swe`; use `npm run typecheck` and `npm run check` for package integration.
- **Non-goals:** no generated review theater, peer-extension imports, hidden workflows, or multi-file filesystem transactions.

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
      "verification": [{ "command": "npm", "args": ["test"] }]
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

### Managed parent integrity

The isolated v2 controller claims one parent owner, Pi session, extension-runtime nonce, repository cwd, and session-branch checkpoint. A competing parent, resumed/forked session, or reloaded runtime cannot inherit that authority. Shutdown invalidates the claim and any in-memory one-shot verification authorizations; the later recovery surface must establish fresh checkpoints rather than reuse stale evidence. The controller is not registered by the installed v1 entrypoint during this staged rollout, so version-1 workflows remain governed by the compatibility runtime and native v2 workflows cannot be activated through a partial production path.

During managed execution the model parent may use only captured, provenance-stable read-only tools and read-only workflow status. Direct `edit`, `write`, general `bash`, alternate shells, `ctx_execute`, MCP execution, `interactive_shell`, batch/nested wrappers, and unknown or dynamically replaced tools fail closed. Protected `bash` is enabled only in the verification phase for the exact planned executable/arguments and cwd. Echo-style fabricated checks are invalid contracts.

Each protected result is bound to its tool-call ID, current parent/session/runtime, workflow revision, task contract, cwd, Git HEAD/branch, and the same whole-source snapshot before and after execution. The snapshot covers every relevant tracked file—including configuration, tests, and lockfiles—plus explicitly selected untracked inputs. A later failure supersedes an earlier pass. Missing checks, results absent from the active session branch, source-changing checks, external-editor drift, and completion-time drift block completion. Source changes enter cumulative remediation and complete independent re-review; the parent does not patch, roll back, or discard accepted deltas directly.

These controls are workflow capability and evidence-integrity checks, **not an OS sandbox**. Pi extensions run with the user's permissions. A malicious same-user process, a trusted extension that executes code behind an approved surface, or a user deliberately disabling the extension can bypass runtime interception. User-issued shell commands and external editors remain user-controlled; subsequent snapshot checks invalidate affected approvals and evidence instead of treating them as still current.

### Git workspace safety

`GitWorkspaceManager` preflights repository capabilities before mutation. It rejects non-root/bare or unborn repositories, unresolved operations/conflicts, submodules, sparse checkouts, and Git filters/LFS instead of falling back to shared-directory execution. It records real HEAD, index tree/hash, separate staged and unstaged patch hashes, and a bounded working-copy fingerprint. Untracked inputs are opt-in; ignored files, dependency/build trees, credentials, and other untracked files are not automatically captured. Selecting ambiguous or sensitive inputs is a user decision.

Each task receives a detached worktree at a pinned synthetic baseline. Synthetic commits plus `refs/pi-swe/baselines/*` and prepared `refs/pi-swe/results/*` are local retention objects, not user commits. Bounded creation intents under the Git common directory recover crashes before a receipt can be persisted; versioned workflow receipts then bind the intent path, ownership marker, worktree administration directory, refs, preimage, and prepared result so restart/resume does not depend on conversation state. Workflow/runtime authority is excluded from source fingerprints and rejected as task output. Integration checks scope, path traversal, escaping symlinks, main-checkout HEAD/index/content drift, untracked collisions, prepared-patch integrity, patch size, and the observed post-image. It applies to the working tree without staging, stashing, resetting, committing on the user branch, or pushing.

Failed, rejected, paused, interrupted, and unfinalized workspaces are retained. Exact expected post-images recover an apply/persist crash without reapplying. Cleanup is ownership-checked, compare-and-delete, and idempotent; it requires the matching finalized integration receipt or explicit discard authorization and removes the worktree, both retention refs, and creation intent. Remediation reconstructs the original task baseline plus its cumulative integrated delta while applying only the new repair delta. Git preimage checks reduce races but are not a filesystem transaction against arbitrary concurrent writers, and isolated worktrees are not an OS sandbox.

### pi-todo interoperability

When pi-todo is also enabled, pi-swe is the sole lifecycle authority while an assessed workflow task is active:

- both model-tool and `/swe work` activation reject an already active todo;
- at most one repository workflow may be active;
- bounded workflow discovery is deterministic and fails closed when topic, directory, depth, or read limits prevent proving exclusive ownership;
- pi-todo does not create guard todos for implementation tools during that interval;
- todo inspection and cleanup remain available; and
- creating, starting, reopening, or restructuring todo work is blocked until pi-swe is paused, blocked, or complete.

## Existing initiatives

When only the former schema-v2 `specs/manifest.json` and `contracts.json` exist, status reads a projection without writing. The first mutation or `/swe migrate <topic>` creates `workflow.json`, preserving executable contract IDs, titles, dependencies, dispositions, active selection, acceptance criteria, planned checks, blocker details, evidence links, and completion provenance. Contract authority must be the topic's `.model-artifacts/initiatives/<topic>/plans/revisions/rN` tree. `create` refuses to shadow any legacy manifest and directs callers to migrate. Old files remain untouched as history and are never dual-written. Once `workflow.json` exists it is the only authority.

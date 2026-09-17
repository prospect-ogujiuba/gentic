# pi-swe

A small, opt-in workflow extension for durable multi-step software work. Normal coding needs no workflow.

## Orientation

- **What it does:** stores a goal and dependency-ordered tasks in one file, instructs the agent to assess applicable engineering approaches during planning, selects at most one active workflow task per repository, binds protected bash results as verification evidence, and advances completed work.
- **Commands/tools:** `/swe status`, `/swe config`, `/swe migrate`, `/swe work`; model-callable `swe_workflow`.
- **Events:** the v2 integrity controller defines fail-closed `tool_call`/`tool_result`, user-shell, agent-start, and session-shutdown guards. The installed v1 runtime remains the production runtime: its entrypoint intentionally does not register the v2 controller until a production fenced-orchestration surface is delivered. Isolated tests exercise v2 with a deterministic fixture provider. Do not hot-reload, self-upgrade, or partially activate v2. Version-1 compatibility views are always excluded until explicit migration.
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

## Explicit workflow migration

Migration never occurs on first mutation. Audit is read-only and bounded:

```text
/swe migrate audit
/swe migrate apply <topic>
/swe migrate apply <topic> reopen
/swe migrate apply <topic> grandfather-read-only
/swe migrate recover <topic>
/swe migrate rollback <topic>
```

Apply is per-topic and requires the selected dry-run classification, exact preimage hash, shared mutation lock, atomic workflow write, and retained recovery receipt under `.model-artifacts/system/logs/pi-swe-migration/`. Repeating the same apply is idempotent; stale plans, concurrent writers, malformed or unknown versions, layout conflicts, and edited rollback postimages fail closed. An interrupted postimage can be finalized with `recover`; rollback compare-and-restores the exact retained preimage and keeps its receipt.

Incomplete or active v1 work is paused, stale execution evidence and leases are cleared, and durable evidence links/import provenance remain. Completed tasks stay immutable historical records and never satisfy fresh v2 review. A completed workflow requires a keyboard-confirmed choice: `reopen` for fresh v2 final acceptance, `grandfather-read-only` for immutable history, or no apply pending operator review. The model-callable tool cannot choose that disposition or authorize rollback.

Run pi-artifacts kind-first relocation before SWE semantic migration. An active pi-artifacts claim, journal, or rollback bundle blocks SWE apply; an applied SWE recovery receipt blocks pi-artifacts until rollback or an explicit later retention/finalization decision. Never delete either authority record manually. Batch operation means individually selecting topics and reporting each outcome; there is no migrate-all path.

The verification array is **required-all**, not alternatives:

1. Run each command with Pi's protected `bash` tool.
2. Immediately bind each result in a later tool turn with `verify`.
3. After any potentially mutating tool runs, rerun every planned check.
4. Call `complete` only after the final `verify`.

Evidence must be newer than the task's activation or latest revision timestamp, workflow revision, session, and branch boundary. Completion rejects evidence missing from the active branch, evidence invalidated by a potentially mutating tool result, incomplete planned checks, and a latest result not bound against the immediately preceding workflow revision. After session-tree compaction or a session change, resume the task to establish a new checkpoint before verifying.

Use `revise` with the desired full task graph to add, remove, or update planned work. Completed, active, and blocked tasks cannot be removed; statuses, evidence, evidence links, completion timestamps, and imported provenance are retained for matching tasks.

Every activation path—commands, model-callable start/resume, and automatic advancement—returns the same coarse implementation guidance. It does not dispatch separate planning, implementation, verification, review, and finalization turns.

## Managed v2 lifecycle

The isolated v2 engine advances one durable stage at a time: plan review, implementation, independent review, optional concern review, safe integration, protected checks, task completion, and final initiative acceptance. Neither `/swe` nor `swe_workflow` may jump a stage. Slash-command and tool control both use `WorkflowControlService`, the same ownership scan, parent claim, lease fencing, mutation service, recovery rules, and completion gates. The command surface intentionally exposes no direct managed completion action; the tool rejects managed `complete` and requires `OrchestrationEngine` advancement.

### Role and concern routing

A fresh `plan-reviewer` must approve the complete contract before any implementer runs. An `implementer` receives only the task contract and its isolated workspace. A fresh `general-reviewer` receives the exact cumulative delta, bounded relevant files, and objective evidence, but not the implementation conversation or its verdict. When the task assessment selects `security`, `performance`, `migration`, `accessibility-ux`, or `operations`, one composed `concern-reviewer` receives only those selected specialist concerns. `tdd`, `diagnosis`, and `dsa` guide implementation and general review rather than creating ceremonial agents. A fresh `final-reviewer` judges the full integrated initiative after every task and final check.

Role routing does not authorize side effects. Reviewers cannot patch, integrate, commit, push, deploy, or release. Final completion means implementation accepted; commit, push, deploy, release, and production rollout each require separate authorization.

### Fresh context and independent judgment

Each role attempt starts in a fresh process with an explicit provider/model, bounded packet, isolated cache, and explicit extension list. Fresh context prevents accidental conversation leakage; it does not guarantee independent judgment when runs use the same model family, provider, prompt design, or training data. Independence here is enforceable provenance separation: a reviewer must have a distinct actor and run, must not self-review, and must review the current snapshot without the implementer's verdict. Use genuinely different reviewers when policy requires stronger organizational or model independence.

### Clarification

A child may return `needs-input` with a stable question ID instead of guessing. The parent stops, displays the question through `/swe work inspect`, and records a durable answer with `/swe work answer`; the tool and engine consume the same workflow response. The resumed stage uses a fresh process and the correlated answer. Clarification is two-way, survives parent restart, and does not consume remediation budget. An unanswered, stale, or mismatched response cannot advance the stage.

### Workflow and task transitions

`workflow.json` is the sole mutable authority. The workflow moves through `plan-review`, `task-execution`, `initiative-acceptance`, and `complete`. A task moves through `pending`, `implementation`, `general-review`, optional `concern-review`, `workspace`, `integration`, `verification`, `ready-to-complete`, and `historical`; rejection enters bounded `remediation`. `paused`, `blocked`, and `complete` are durable workflow states. Runtime outcomes remain distinct: `cancelled`, `interrupted`, `crashed`, `timed-out`, `changes-requested`, `blocked`, and `completed` are never inferred from process exit alone.

Every child holds a fenced, expiring lease. Two concurrent parents cannot share authority. Cancellation invalidates the lease before process termination, so a late result or clean exit cannot become success. Parent restart invalidates in-memory grants and reports orphaned or expired leases; explicit resume establishes a new parent checkpoint. Accepted reports, findings, workspace and integration receipts, clarification responses, manual decisions, and recovery history live in `workflow.json`, so dismissing a bounded runtime tail cannot delete them.

### Dependency setup

Install the repository's pinned dependencies with `npm install` (or the lockfile-equivalent clean install used by CI) before running fixtures. Native child processes resolve the pinned Pi CLI and required packages from the isolated workspace bootstrap; symlinked dependency trees are rejected. Ordinary CI uses local process fixtures and a deterministic fixture provider—no network, discovery, hot reload, self-upgrade, or production activation is required.

Run `npm run test:swe`, `npm test`, `npm run check`, and `npm run typecheck`. A real-model smoke test is optional and must be skipped unless credentials and explicit user authorization are both available; record the skip honestly. A smoke test never substitutes for deterministic CI.

### Manual validation

When behavior cannot be checked objectively (for example, target hardware or a human-perception judgment), the plan records an explicit manual-validation decision rather than a fabricated passing command. `/swe work validate` requires a keyboard-accessible approval or rejection, rationale, confirmation, actor, and timestamp. Manual validation cannot replace independent final acceptance: after an approved manual observation, a fresh final reviewer must still accept the current initiative snapshot. Rejection creates scoped follow-up work that re-enters implementation, review, integration, and verification.

### Post-integration repair

Failed checks, inadequate tests, reviewer disagreement, source-changing verification, and whole-snapshot drift invalidate approval. They enter the same cumulative remediation path; the parent never patches or silently rolls back integrated work. Repair starts from the original baseline plus every accepted delta, then receives complete independent re-review. Follow-up tasks need bounded write scope, non-goals, acceptance criteria, and verification. The remediation budget is durable and cumulative; exhaustion blocks until a keyboard-confirmed, reasoned reset is recorded.

### Native run inspection

Native SWE children are non-PTY processes. Inspect durable stage, role, provider/model, elapsed time, outcome, findings, clarifications, retry budget, workspace receipts, and recovery advice with `/swe work inspect <topic>` or `swe_workflow action=inspect`. Use `/swe work runs <topic>` or `swe_workflow action=runs` for bounded report and output tails. Full transcripts and unbounded diagnostics are not retained; authorized initiative diagnostics belong only in its `logs/` or `reports/` directories.

Interactive-shell `/attach` does not apply to native SWE runs because they are not interactive-shell sessions and have no PTY to attach. Pause or stop through the workflow controls; do not infer state from an OS process alone.

### Upgrade and migration

Version-1 reads are non-mutating. Native v1 workflows and former manifest/contracts initiatives require explicit audited migration before mutation; no start, resume, or ordinary service call upgrades them implicitly. Migration preserves durable evidence and provenance while stale execution evidence is invalidated; historical completion labels remain historical and cannot satisfy fresh review or final acceptance. A legacy kind-first layout is read-only, and a canonical/legacy layout conflict blocks instead of choosing or shadowing one. Production remains on the installed v1 entrypoint until a separately reviewed rollout authorizes v2 registration.

The rollout bootstrap has one narrow adoption path. It is pinned to plan commit `e882cd62deb541aa437c16c72781a1ccd243055e`, must run before any workflow stage starts, and may complete only the ordered prefix before `cutover-readiness`. The Git descendant delta must stay within those tasks' combined write scopes. A fresh plan reviewer, fresh general reviewer, and one fresh composed reviewer for all selected specialist concerns must approve the same snapshot; blocking findings need recorded decisions. Every adopted task command is rerun exactly through protected v2 authority on that unchanged snapshot. The adoption record preserves those reviews, check receipts, authorization, anchor, task order, and snapshot without fabricating normal child reports. It never supplies final initiative acceptance: native work starts at `cutover-readiness`, and full current closeout checks plus a fresh final reviewer remain mandatory.

Dirty index and working-tree content are captured separately without staging or resetting. Untracked inputs require explicit selection; ambiguous or sensitive files require a user decision and are never selected implicitly. Binary content, file mode changes, and symlinks are fingerprinted and integrated exactly, with escaping links rejected. Bare, non-root, unborn, conflicted, sparse, submodule, filter, and LFS repositories are unsupported and fail before mutation.

### Explicit tool trust

Managed execution allows only an explicitly trusted tool identity with stable provenance. Reads are bounded; protected `bash` is a one-shot capability for the exact planned command, arguments, cwd, parent, contract, branch, and whole-source snapshot. Unknown, dynamically replaced, nested, alternate-shell, write, MCP execution, and interactive execution surfaces fail closed. These controls are integrity mechanisms, not an OS sandbox: extensions and same-user processes retain the user's operating-system permissions, while later snapshot checks detect drift.

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

When only the former schema-v2 `specs/manifest.json` and `contracts.json` exist, status reads a projection without writing. Only the explicit audited migration flow creates `workflow.json`, preserving executable contract IDs, titles, dependencies, dispositions, active selection, acceptance criteria, planned checks, blocker details, evidence links, and completion provenance. Contract authority must be the topic's `.model-artifacts/initiatives/<topic>/plans/revisions/rN` tree. `create` refuses to shadow any legacy manifest and directs callers to migrate. Old files remain untouched as history and are never dual-written. Once `workflow.json` exists it is the only authority.

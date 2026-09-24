# pi-swe

pi-swe provides one validated durable initiative at `.model-artifacts/initiatives/<topic>/workflow.json` and one unified `todo` capability. Workflow files remain the sole planning authority; reports, revision logs, session entries, and UI projections never become a second task ledger. `SweService` is the workflow mutation authority used by commands, structured tools, and docket-backed actions.

## Lifecycle and authority

Bootstrap authority only through the structured `swe` tool's `create` action with a complete proposal. Creation validates the closed schema and artifact paths/hashes, requires matching canonical identity, revision `1`, `draft` status, empty evidence, and pending executable work with acceptance-criterion coverage, verification obligations, and no dispositions. It revalidates authority-parent identity and artifact hashes through publication, uses cooperative locking, a stable directory-descriptor path, exclusive no-overwrite publication, file and directory sync, and never replaces an existing `workflow.json`. Creation fails closed when the runtime exposes neither `/proc/self/fd` nor `/dev/fd` for stable parent-relative operations. `/swe plan [--id <kebab-topic>] <request>` starts an agent planning turn from natural language, derives a collision-free canonical topic when `--id` is omitted, and directs the model to bootstrap only through `swe create`. The command never writes `workflow.json` itself.

The domain layer enforces a closed schema, graph/reference/coverage rules, bounded hierarchy, dependency readiness, legal transitions, and evidence-gated completion. Later mutations use revision/hash compare-and-swap, an in-process queue, an exclusive cross-process lock, atomic rename, directory sync, and immutable Markdown revision rationale.

Pause, interruption, fork, and resume do not rewind repository state. Session entries retain only focus; every fresh context projection rereads current repository authority and revision. A focused active initiative with unfinished work triggers a bounded continuation turn on startup/resume; its approved workflow is standing authorization for routine reversible implementation, verification, corrective fixes, and cleanup. Continuation still stops for credentials, destructive or irreversible operations, required contract/scope revision, genuine blockers, or authorization not already granted by the user or repository policy. Draft, paused, complete, abandoned, and all-terminal initiatives do not auto-run. Concurrent or stale writers fail closed instead of silently overwriting current authority.

## Unified todo authority

The pi-swe entrypoint is the sole registration point for both `swe` and `todo` commands and structured tools. A focused active initiative selects the workflow backend on every operation and modal opening. That backend rereads `workflow.json`, projects hierarchy/readiness/raw statuses directly, routes `start` through `SweService.start`, and maps todo `finish` only to `SweService.markImplemented`. Verification, review, work completion, and initiative completion remain exclusively SWE-gated. Structural todo actions are disabled in workflow mode and direct callers to intentional `swe revise` rather than editing workflow authority indirectly.

Without a focused active initiative, the same todo surface selects the standalone branch backend. It reconstructs historical `gentic.todo.event` version-1 entries from the active session branch and appends the same rollback-compatible event envelopes. Switching providers never copies or synchronizes data: paused, draft, complete, abandoned, or unfocused workflow authority exposes the preserved standalone branch state again. A focused authority that is missing, malformed, or unreadable fails closed instead of falling back to standalone writes. One provider-neutral docket and modal render both modes while retaining workflow-specific `implemented` versus `complete` statuses and per-item capabilities.

Standalone actions remain `create`, `move`, `delete`, `start`, `finish`, `block`, `unblock`, and `list`, with `/todo open` for the shared modal. The core keeps at most one standalone todo active, supports ordered subtasks, and bounds public state and text. No independent `pi-todo` extension or optional lifecycle bridge remains.

## Verification and completion

Verification never calls `pi.exec` or a hidden subprocess runner. `prepare_verification` records an exact command and bounded relevant-source snapshot, then requires the model/operator to invoke Pi's ordinary `bash` tool with exactly that command. Installed `tool_call` permission handlers therefore review the command normally. pi-swe observes the matching call/result and stores only actual pass/fail outcome metadata and hashes.

Each obligation declares its required evidence kinds. `model-review` is a runtime-recorded, source-bound self-review with explicit dimensions and `pi-model-self-review` provenance; it is not independent or human review. RED/GREEN obligations require an observed failed ordinary-bash command before the passing command. Missing, aborted, failed, stale, wrong-contract, wrong-kind, or later failing evidence cannot complete work. A new explicit `prepare_verification` supersedes an unmatched or interrupted pending observation, so recovery does not require a runtime reload; exact tool-call binding prevents late results from attaching to the replacement. v0.1 has no model-supplied waiver action.

Qualification may use the declared `test-after` approach: combine incremental evidence with integrated user-scenario and repository checks after implementation. The stored testing approach and reason remain explicit.

### Opt-in work-item commits

An initiative opts in with `"policies": { "commitOnWorkCompletion": true }`. Omitting the policy or setting it to `false` preserves current behavior. No per-work path or message mapping is required. The matching work item must first pass the normal evidence-backed `complete` transition.

Successful completion derives literal scoped paths from that work item's current-contract passing verification evidence, excludes `.gitignore`, Git metadata, artifact `logs/`, traversal, and wildcard pathspecs, adds the initiative's `workflow.json`, and derives a bounded conventional message from the work title. Verification `relevantPaths` therefore define commit attribution and should enumerate every task-owned source, test, documentation, and generated file.

Pi-swe prepares an exact Git command for Pi's ordinary `bash` tool instead of calling `pi.exec` or a hidden subprocess. Structured-tool output carries it as `details.completionCommit`; command-driven completion schedules a bounded follow-up turn. The command uses a temporary index, commits only the derived paths, preserves unrelated staged and unstaged paths, and never pushes.

Workflow completion and Git are not one atomic transaction. If passing evidence has no safe attributable paths, pi-swe reports `completionCommitError` and leaves the work item complete. If the repository is not a Git worktree, the scoped diff is empty, identity or hooks reject the commit, or Git otherwise fails, the ordinary bash failure is reported for manual recovery. A commit must not be claimed until that command succeeds.

## Proportional initiatives

Small initiatives stay small. A light initiative may contain one executable task without a phase, one justified practice, and one concrete obligation. No universal phase hierarchy, exhaustive discipline checklist, or irrelevant review ceremony is required. Deeper assessment and additional practices are selected only when observed engineering surfaces justify them; completion integrity is unchanged at every depth.

## Surfaces and output

Public surfaces are `/swe plan [--id <topic>] <request>`, `/swe list [<topic>]`, `/swe open|status|next|resume|pause <topic>`, `/swe start|implemented|complete <topic> <work-id>`, `/swe complete <topic>` for explicit initiative finalization, one `swe` structured tool whose actions include the sole supported `create` bootstrap, `/todo`, and one `todo` structured tool. Bare `/swe` and `/todo` show authority-aware help. Local action specifications supply completion labels, syntax, help, and invalid-input usage through the shared presentation kernel; adapters still own parsing, authority selection, legal-transition filtering, execution, and lifecycle messages. SWE argument completion discovers validated `workflow.json` authorities and offers only relevant work IDs; completion remains advisory and cannot bypass lifecycle or evidence gates. Finalization requires active authority and every executable work item to be complete or intentionally disposed. The shared keyboard docket is a bounded projection of the selected provider. Bare `/swe list` returns a responsive two-line overview without changing focus: the complete copyable initiative ID appears alone, followed by revision, progress, status, and actionable current or next work. The host UI wraps naturally instead of receiving fixed-width padding or truncation. `/swe list <topic>` and non-TUI `open` return bounded work-docket text.

## Artifact boundary

Referenced artifacts use safe canonical paths beneath `.model-artifacts/initiatives/<topic>/<kind>/`, with optional verified content hashes. Create model-generated Markdown through pi-artifacts, then attach its returned path and hash through a reviewed initiative revision. Artifacts support authority but do not replace it. Schema identity is `kind: gentic.swe.initiative` with `schemaVersion: 1`, and `workflow.json` remains exclusively owned by pi-swe.

## Qualification

Repository qualification runs the exact gates `npm run typecheck`, `npm run check`, `npm run check:commands`, and `npm test`. Failures are reported rather than converted into completion evidence. Focused suites cover persistence interruption, permissions, negative completion, shared mutation authority, bounded context/session branching, artifact and schema compatibility, keyboard/bounded/non-TUI rendering, and proportional light initiatives.

There are no separate autonomous agents, worktrees, leases, runtime selectors, releases, pushes, or deployments. Opt-in work-item commits are delegated to the existing Pi agent through the ordinary bash permission boundary; bounded continuation otherwise advances the focused active workflow through that same agent and normal permission gates.

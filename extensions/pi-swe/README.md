# pi-swe

pi-swe provides one validated durable initiative at `.model-artifacts/initiatives/<topic>/workflow.json` and one unified `todo` capability. Workflow files remain the sole planning authority; reports, revision logs, session entries, and UI projections never become a second task ledger. `SweService` is the workflow mutation authority used by commands, structured tools, and docket-backed actions.

## Lifecycle and authority

Bootstrap authority only through the structured `swe` tool's `create` action with a complete proposal. Creation validates the closed schema and artifact paths/hashes, requires matching canonical identity, revision `1`, `draft` status, empty evidence, pending executable work with acceptance-criterion coverage, verification obligations, no dispositions, `policies.independentReviewOnCompletion: true`, and at least one designated `independent-review` obligation. Legacy schema-version-1 authorities without that policy remain readable, but newly created initiatives cannot omit the independent review gate. It revalidates authority-parent identity and artifact hashes through publication, uses cooperative locking, a stable directory-descriptor path, exclusive no-overwrite publication, file and directory sync, and never replaces an existing `workflow.json`. Creation fails closed when the runtime exposes neither `/proc/self/fd` nor `/dev/fd` for stable parent-relative operations. `/swe plan [--id <kebab-topic>] <request>` starts an agent planning turn from natural language, derives a collision-free canonical topic when `--id` is omitted, and directs the model to bootstrap only through `swe create`. The command never writes `workflow.json` itself.

The domain layer enforces a closed schema, graph/reference/coverage rules, bounded hierarchy, dependency readiness, legal transitions, and evidence-gated completion. Later mutations use revision/hash compare-and-swap, an in-process queue, an exclusive cross-process lock, atomic rename, directory sync, and immutable Markdown revision rationale.

Pause, interruption, fork, and resume do not rewind repository state. Session entries retain only focus; every fresh context projection rereads current repository authority and revision. A focused active initiative with unfinished work triggers a bounded continuation turn on startup/resume; its approved workflow is standing authorization for routine reversible implementation, verification, corrective fixes, and cleanup. Continuation still stops for credentials, destructive or irreversible operations, required contract/scope revision, genuine blockers, or authorization not already granted by the user or repository policy. Draft, paused, complete, abandoned, and all-terminal initiatives do not auto-run. Concurrent or stale writers fail closed instead of silently overwriting current authority.

## Unified todo authority

The pi-swe entrypoint is the sole registration point for both `swe` and `todo` commands and structured tools. The todo surface presents three separate authorities:

- **session** — fork-aware `gentic.todo.event` entries reconstructed only from the active Pi session branch. Rewind and fork semantics remain unchanged.
- **project** — lightweight shared work in the repository-root, tracked `.pi-todos.json` snapshot. It survives distinct Pi sessions and clones through normal Git operations.
- **initiative** — a direct projection of the focused active `.model-artifacts/initiatives/<topic>/workflow.json`. It is never copied into either lightweight authority.

Unscoped operations preserve compatibility: a focused active initiative is selected automatically; otherwise the session authority is selected. Durable project mutations always require `scope: "project"` in the tool or a `/todo project ...` command. Explicit `/todo session ...` and `/todo project ...` remain accessible while an initiative is focused. `/todo all list` and `/todo all open` provide a bounded read-only combined view with scope-qualified IDs; all-scope mutation is rejected.

The initiative backend rereads `workflow.json` before every operation, routes `start` through `SweService.start`, and maps todo `finish` only to `SweService.markImplemented`. Verification, review, work completion, and initiative completion remain exclusively SWE-gated. Structural todo actions direct callers to intentional `swe revise`. A missing, malformed, or unreadable automatically selected initiative fails closed instead of falling back to session writes.

The project file uses a closed versioned schema, bounded items/text, cooperative exclusive locking, revision/hash compare-and-swap, same-directory temporary publication, atomic rename, file and directory sync, and non-symlink path checks. Malformed state, stale writers, lock conflicts, interrupted publication, and unsafe paths fail closed without resetting the file. Project mutations never commit or push automatically; `.pi-todos.json` is reviewed and staged like any other tracked project file and may produce ordinary Git merge conflicts.

All lightweight scopes support `create`, `move`, `delete`, `start`, `finish`, `block`, `unblock`, and `list`, with `open` as a command-only visual action. Each lightweight authority keeps at most one active item and supports ordered subtasks. There is no promotion, synchronization, or automatic conversion among session, project, and initiative items, and no backlog lifecycle. Every item has exactly one canonical authority.

## Verification and completion

Verification never calls `pi.exec` or a hidden subprocess runner. `prepare_verification` records an exact command and bounded relevant-source snapshot, then requires the model/operator to invoke Pi's ordinary `bash` tool with exactly that command. Installed `tool_call` permission handlers therefore review the command normally. pi-swe observes the matching call/result and stores only actual pass/fail outcome metadata and hashes.

Each obligation declares its required evidence kinds. `model-review` is a runtime-recorded, source-bound self-review with explicit dimensions and `pi-model-self-review` provenance; it is not independent or human review. `independent-review` requires an implemented work item, current bounded source snapshot, passing outcome, dimensions and summary, plus `pi-interactive-session-review` provenance naming a reviewer session distinct from the recording session. Call `swe prepare_independent_review`, launch another Pi session through `interactive_shell` with the returned token instruction, wait for it to exit, then query that session so pi-swe observes the completed token-bearing output. Only that observed exited-session result creates evidence; launching a session or supplying a reviewer ID never does. RED/GREEN obligations require an observed failed ordinary-bash command before the passing command. Missing, aborted, failed, stale, wrong-contract, wrong-kind, or later failing evidence cannot complete work. A new explicit `prepare_verification` supersedes an unmatched or interrupted pending observation, so recovery does not require a runtime reload; exact tool-call binding prevents late results from attaching to the replacement. v0.1 has no model-supplied waiver action.

Qualification may use the declared `test-after` approach: combine incremental evidence with integrated user-scenario and repository checks after implementation. The stored testing approach and reason remain explicit.

### Opt-in work-item commits

The closed `policies` object supports two controls: `commitOnWorkCompletion` remains an explicit boolean opt-in, while `independentReviewOnCompletion` is required for every newly created initiative. Historical authorities may omit the latter for compatibility. Setting `commitOnWorkCompletion` to `false` preserves no-commit behavior and does not weaken the independent review gate. No per-work path or message mapping is required. The matching work item must first pass the normal evidence-backed `complete` transition.

Successful completion derives literal scoped paths from that work item's current-contract passing verification evidence, excludes `.gitignore`, Git metadata, artifact `logs/`, traversal, and wildcard pathspecs, adds the initiative's `workflow.json`, and derives a bounded conventional message from the work title. Verification `relevantPaths` therefore define commit attribution and should enumerate every task-owned source, test, documentation, and generated file.

Pi-swe prepares an exact Git command for Pi's ordinary `bash` tool instead of calling `pi.exec` or a hidden subprocess. Structured-tool output carries it as `details.completionCommit`; command-driven completion schedules a bounded follow-up turn. The command uses a temporary index, commits only the derived paths, preserves unrelated staged and unstaged paths, and never pushes.

Workflow completion and Git are not one atomic transaction. If passing evidence has no safe attributable paths, pi-swe reports `completionCommitError` and leaves the work item complete. If the repository is not a Git worktree, the scoped diff is empty, identity or hooks reject the commit, or Git otherwise fails, the ordinary bash failure is reported for manual recovery. A commit must not be claimed until that command succeeds.

## Proportional initiatives

Small initiatives stay small. A light initiative may contain one executable task without a phase, one justified practice, and one concrete obligation. No universal phase hierarchy, exhaustive discipline checklist, or irrelevant review ceremony is required. Deeper assessment and additional practices are selected only when observed engineering surfaces justify them; completion integrity is unchanged at every depth.

## Surfaces and output

Public surfaces are `/swe plan [--id <topic>] <request>`, `/swe list [<topic>]`, `/swe open|status|next|resume|pause <topic>`, `/swe start|implemented|complete <topic> <work-id>`, `/swe complete <topic>` for explicit initiative finalization, one `swe` structured tool whose actions include the sole supported `create` bootstrap, `/todo [session|project|initiative|all] <action>`, and one scope-aware `todo` structured tool. Bare `/swe` and `/todo` show authority-aware help. Local action specifications supply completion labels, syntax, help, and invalid-input usage through the shared presentation kernel; adapters still own parsing, authority selection, legal-transition filtering, execution, and lifecycle messages. SWE argument completion discovers validated `workflow.json` authorities and offers only relevant work IDs; completion remains advisory and cannot bypass lifecycle or evidence gates. Finalization requires active authority and every executable work item to be complete or intentionally disposed. The shared keyboard docket is a bounded projection of the selected provider. Bare `/swe list` returns a responsive two-line overview without changing focus: the complete copyable initiative ID appears alone, followed by revision, progress, status, and actionable current or next work. The host UI wraps naturally instead of receiving fixed-width padding or truncation. `/swe list <topic>` and non-TUI `open` return bounded work-docket text.

## Artifact boundary

Referenced artifacts use safe canonical paths beneath `.model-artifacts/initiatives/<topic>/<kind>/`, with optional verified content hashes. Create model-generated Markdown through pi-artifacts, then attach its returned path and hash through a reviewed initiative revision. Artifacts support authority but do not replace it. Schema identity is `kind: gentic.swe.initiative` with `schemaVersion: 1`, and `workflow.json` remains exclusively owned by pi-swe.

## Qualification

Repository qualification runs the exact gates `npm run typecheck`, `npm run check`, `npm run check:commands`, and `npm test`. Failures are reported rather than converted into completion evidence. Focused suites cover persistence interruption, permissions, negative completion, shared mutation authority, bounded context/session branching, artifact and schema compatibility, keyboard/bounded/non-TUI rendering, and proportional light initiatives.

There are no separate autonomous agents, worktrees, leases, runtime selectors, releases, pushes, or deployments. Opt-in work-item commits are delegated to the existing Pi agent through the ordinary bash permission boundary; bounded continuation otherwise advances the focused active workflow through that same agent and normal permission gates.

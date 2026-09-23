# pi-swe

pi-swe provides one validated durable initiative at `.model-artifacts/initiatives/<topic>/workflow.json`. That file is the sole planning authority; reports, revision logs, session entries, and UI projections never become a second task ledger. `SweService` is the mutation authority used by commands, the structured tool, and docket-backed actions.

## Lifecycle and authority

Bootstrap authority only through the structured `swe` tool's `create` action with a complete proposal. Creation validates the closed schema and artifact paths/hashes, requires matching canonical identity, revision `1`, `draft` status, empty evidence, and pending executable work with acceptance-criterion coverage, verification obligations, and no dispositions. It revalidates authority-parent identity and artifact hashes through publication, uses cooperative locking, a stable directory-descriptor path, exclusive no-overwrite publication, file and directory sync, and never replaces an existing `workflow.json`. Creation fails closed when the runtime exposes neither `/proc/self/fd` nor `/dev/fd` for stable parent-relative operations. `/swe plan [--id <kebab-topic>] <request>` starts an agent planning turn from natural language, derives a collision-free canonical topic when `--id` is omitted, and directs the model to bootstrap only through `swe create`. The command never writes `workflow.json` itself.

The domain layer enforces a closed schema, graph/reference/coverage rules, bounded hierarchy, dependency readiness, legal transitions, and evidence-gated completion. Later mutations use revision/hash compare-and-swap, an in-process queue, an exclusive cross-process lock, atomic rename, directory sync, and immutable Markdown revision rationale.

Pause, interruption, fork, and resume do not rewind repository state. Session entries retain only focus; every fresh context projection rereads current repository authority and revision. A focused active initiative with unfinished work triggers a bounded continuation turn on startup/resume; its approved workflow is standing authorization for routine reversible implementation, verification, corrective fixes, and cleanup. Continuation still stops for credentials, destructive or irreversible operations, required contract/scope revision, genuine blockers, or authorization not already granted by the user or repository policy. Draft, paused, complete, abandoned, and all-terminal initiatives do not auto-run. Concurrent or stale writers fail closed instead of silently overwriting current authority.

## Verification and completion

Verification never calls `pi.exec` or a hidden subprocess runner. `prepare_verification` records an exact command and bounded relevant-source snapshot, then requires the model/operator to invoke Pi's ordinary `bash` tool with exactly that command. Installed `tool_call` permission handlers therefore review the command normally. pi-swe observes the matching call/result and stores only actual pass/fail outcome metadata and hashes.

Each obligation declares its required evidence kinds. `model-review` is a runtime-recorded, source-bound self-review with explicit dimensions and `pi-model-self-review` provenance; it is not independent or human review. RED/GREEN obligations require an observed failed ordinary-bash command before the passing command. Missing, aborted, failed, stale, wrong-contract, wrong-kind, or later failing evidence cannot complete work. A new explicit `prepare_verification` supersedes an unmatched or interrupted pending observation, so recovery does not require a runtime reload; exact tool-call binding prevents late results from attaching to the replacement. v0.1 has no model-supplied waiver action.

Qualification may use the declared `test-after` approach: combine incremental evidence with integrated user-scenario and repository checks after implementation. The stored testing approach and reason remain explicit.

## Proportional initiatives

Small initiatives stay small. A light initiative may contain one executable task without a phase, one justified practice, and one concrete obligation. No universal phase hierarchy, exhaustive discipline checklist, or irrelevant review ceremony is required. Deeper assessment and additional practices are selected only when observed engineering surfaces justify them; completion integrity is unchanged at every depth.

## Surfaces and output

Public surfaces are `/swe plan [--id <topic>] <request>`, `/swe open|list|status|next|resume|pause <topic>`, `/swe start|implemented|complete <topic> <work-id>`, `/swe complete <topic>` for explicit initiative finalization, and one `swe` structured tool whose actions include the sole supported `create` bootstrap. Bare `/swe` shows focused quick help. One local action specification supplies completion labels, syntax, help, and invalid-input usage through the shared presentation kernel; the pi-swe adapter still owns parsing, initiative discovery, ranking, legal-transition filtering, blockers, execution, and lifecycle messages. Argument completion discovers validated `workflow.json` authorities, shows compact status/revision/progress context, filters initiatives by action, and offers only relevant ready or active work IDs; completion remains advisory and cannot bypass lifecycle or evidence gates. Finalization requires active authority and every executable work item to be complete or intentionally disposed. The keyboard docket is a bounded, read-only projection of the canonical graph; command and tool mutations both use `SweService`. Non-TUI `open` and `list` return bounded text. pi-swe has no pi-todo dependency; pi-todo remains a thin separate surface and cannot write SWE authority.

## Artifact boundary

Referenced artifacts use safe canonical paths beneath `.model-artifacts/initiatives/<topic>/<kind>/`, with optional verified content hashes. Create model-generated Markdown through pi-artifacts, then attach its returned path and hash through a reviewed initiative revision. Artifacts support authority but do not replace it. Schema identity is `kind: gentic.swe.initiative` with `schemaVersion: 1`, and `workflow.json` remains exclusively owned by pi-swe.

## Qualification

Repository qualification runs the exact gates `npm run typecheck`, `npm run check`, `npm run check:commands`, and `npm test`. Failures are reported rather than converted into completion evidence. Focused suites cover persistence interruption, permissions, negative completion, shared mutation authority, bounded context/session branching, artifact and schema compatibility, keyboard/bounded/non-TUI rendering, and proportional light initiatives.

There are no separate autonomous agents, worktrees, leases, runtime selectors, releases, commits, or deployments. Bounded continuation only advances the focused active workflow through the existing Pi agent and normal permission gates.

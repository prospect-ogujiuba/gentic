# pi-swe foundation — approved design

Topic: pi-swe-foundation

## Authority and approval

The user approved the discovery design and all four recommendations, then authorized phased implementation. `../workflow.json` is the sole planning authority. This document records architecture, not a second task tracker. The initial JSON is manually bootstrapped: no installed SWE extension has validated or adopted it yet. Never fabricate execution receipts for bootstrap work.

## Product

Make Pi perform software engineering proportionally: inspect → identify engineering surfaces → select justified practices → derive concrete Definition of Done obligations → plan → implement → collect evidence → verify. LLMs own semantic judgment; deterministic code owns structural integrity. Tiny changes receive tiny initiatives, not mandatory phases or universal checklists.

Accepted decisions:
- Retire independent TODO write authority for engineering work. Preserve legacy inspection and explicit import; do not mirror initiative work into TODO session events.
- Automatically create minimal durable initiatives for actual implementation requests, not questions or discussion. Explicit `/swe plan` remains available. The model decides applicability; no hidden keyword-triggered classifier call.
- v0.1 enforces mutation/completion gates and gives clear guidance; it does not blanket-block coding tools before assessment.
- The model may propose practice exclusions during assessment. Waiving an already-required obligation requires explicit human approval; a model-supplied actor string is not approval.

## Repository findings

HEAD at discovery: 508da86 (`nuke pi-swe`), deleting 22 files / 10,405 lines. Do not restore the former orchestration engine. The deleted implementation left tests, workflows, release/migration contracts, and a discoverable orchestration skill behind.

- Pi package baseline: 0.84.2; global Pi/docs were 0.86.1. Target the pinned local API, without a dependency upgrade.
- `extensions/pi-todo/src/state-core.ts`: branch-local `gentic.todo.event` ledger, one active task, no graph or verification. Its legacy normalization collapses failed/cancelled/needs_review into completed; those values cannot prove verified completion.
- `extensions/pi-todo/src/pi/swe-ownership.ts`: dangling import from deleted `pi-swe/src/store.ts`; typecheck currently fails here.
- `extensions/pi-todo/src/ui/`: reusable docket/modal presentation. Historical SWE integration was mutual exclusion, not a task projection.
- `extensions/pi-artifacts/`: bounded layout migration, reference rewriting, apply/recovery/rollback; not a general artifact store or ID registry.
- `docs/model-artifacts.md`: topic-first layout, stable workflow.json, timestamped Markdown, kinds specs/plans/todo/findings/reports/logs.
- `extensions/pi-primitives/primitives/model-artifacts/`: prompt convention injection.
- `extensions/pi-context/`: bounded native context-pressure reporting, not initiative context management.
- `skills/swe-orchestration/`: stale operator guidance for the deleted engine; replace or retire intentionally.
- Historical `.model-artifacts/initiatives/{multi-agent-swe-orchestration,swe-production-rollout}/workflow.json`: preserve unchanged, never automatically resume.

## Boundaries

Use `extensions/pi-swe/index.ts` with `src/domain`, `src/app`, `src/pi`, and `src/ui` as needed, following the native extension conventions.

Domain: schema, graph validation, readiness, obligations, completion evaluation.
Application: one mutation service, atomic store, evidence collection, bounded projections.
Pi adapters: commands, structured tools, lifecycle hooks, permission integration.
UI: reuse/adapt TODO presentation against a projection of the canonical graph.

SWE must work without loading pi-todo. pi-todo may expose a view/command alias, but must delegate to the same mutation service and never bypass completion gates. Share only concrete presentation types or artifact path helpers; no generic framework.

Keep pi-artifacts independent. Reuse normalized project-relative `path` and optional `contentHash`; do not invent an artifact registry. Do not invoke repository-wide migration scans on every turn. Artifact migration and semantic initiative migration remain separate.

## Initiative model

Location: `.model-artifacts/initiatives/<topic>/workflow.json`.
Identity: `kind: gentic.swe.initiative`, `schemaVersion: 1`, explicitly distinct from historical `version: 1|2` documents.

Represent objective, scope/non-goals/constraints, acceptance criteria, assessment, selected practices, derived obligations, work, artifact references, compact evidence, current decisions/risks, revision, and status. All large reports remain referenced artifacts.

Use flat work arrays with durable IDs and explicit parentId. Bound hierarchy to optional phase → task → optional subtask; only leaves execute. Dependencies connect executable leaves for v0.1. Parent progress and readiness are derived, not separately writable state. Research can complete using appropriate findings/review rather than fake implementation tests.

Initiative lifecycle: draft/active/paused/complete/abandoned. Leaf lifecycle: pending/active/implemented/blocked/complete. Implemented is not verified complete. Define cancellation/supersession semantics deliberately during schema work, without conflating them with completion.

Separate document mutation revision from requirement-bearing contract fingerprints. Recording evidence must not stale unrelated evidence. Revisions to scope, requirements, tests, dependencies, or relevant source invalidate affected approval/evidence. Significant changes require rationale and traceable history outside the current-state document; the JSON is not an append-only log.

The bootstrap JSON is a concrete proposed instance, not a claim that the complete runtime schema is settled. Refine it intentionally during schema implementation, preserving IDs and approval provenance.

## Applicability and Definition of Done

An engineering obligation is the key abstraction: not merely `security`, but `authorization denial is verified for another tenant`.

Assessment records observed surface, uncertainty, depth (light/standard/deep), and rationale. Practices record why they apply and to which work. Obligations connect those practices to acceptance criteria and evidence requirements. Store meaningful exclusions, not a negative checklist for every discipline.

Support correctness, architecture, security, accessibility, UX, data, APIs, DSA, performance, reliability, observability, developer experience, and delivery when relevant. DSA needs input-size/access-pattern/complexity reasoning; performance needs measurement; UI needs inspection of existing design language. Do not manufacture relevance.

Testing approaches: TDD, regression-first, characterization-first, test-after, exploratory, configuration/manual. Require reasons. RED must fail for the intended behavior, not fixture breakage. Code enforces observation order; the model judges failure meaning and test quality. Self-review covers selected dimensions only and does not pretend to be independent review.

## Persistence and evidence integrity

Enforce closed bounded schemas, stable unique IDs, references, hierarchy depth, acyclic dependencies, legal transitions, coverage, current required evidence, safe paths, and intentional revisions.

Use an in-process file mutation queue plus cross-process exclusion and expected-revision/hash checks around the complete read-modify-write window. Atomic publish must leave old or new valid authority on interruption. Document stale-lock recovery; do not silently steal locks. Recheck cancellation inside queued execution. No speculative distributed ownership engine.

Evidence records exact command/args/cwd, actual outcome, timing, work/check IDs, contract fingerprint, before/after relevant source snapshot, provenance, and output hash/report reference. Include relevant tests/config/lockfiles and newly created source in freshness reasoning; never claim whole-source integrity from Git HEAD alone. Declare bounds and unsupported cases honestly.

Pinned Pi BashToolDetails does not supply a structured exitCode. Do not parse arbitrary prose as proof. Build a narrow structured verification collection path and ensure it receives permission review equivalent to ordinary shell execution: internal pi.exec calls do not automatically inherit bash permission policy. Inspect the actual installed permission integration before choosing an adapter. No hidden unrestricted command runner.

Manual observations and LLM reviews are labeled distinctly from machine observations. Persist bounded evidence needed across sessions rather than relying only on session tool-call IDs. Completion does not authorize commits, pushes, deployments, release, cleanup, or self-upgrade.

Publish immutable supporting evidence before referencing it in workflow.json. A crash may leave an orphan artifact; never automatically delete it. No second planning authority in receipt/report files.

## Artifacts and context

Investigation → findings; architecture/ADRs → specs; verification/audits → reports; significant change history → logs. Narrative plans are supporting documents, not task authority. Screenshot and benchmark JSON support needs a narrow intentional update to canonical layout validation; current ordinary initiative rules accept timestamped Markdown only.

Inject a fresh bounded projection, not the full JSON: objective/non-goals, current leaf, prerequisites, applicable obligations/criteria, critical risks/decisions, missing evidence, artifact summaries/paths. Target 1,000–2,000 tokens maximum, much less for light work. Collapse completed work; fetch reports on demand. Replace only SWE-owned stale context; preserve other extensions' content. Use native Pi compaction.

Session custom entries hold selection/focus, not duplicate task state. Session tree/fork/resume does not rewind repository authority. Reread current revision and revalidate evidence. No automatic execution at startup/resume.

Minimal commands: `/swe plan`, `/swe status`, `/swe next`, `/swe resume`, `/swe pause`. One structured model tool may expose narrow validated actions. Add UI commands only for demonstrated use.

## Migration and future work

Preserve historical workflows and artifact recovery data. Unknown/legacy schema execution fails with clear guidance. Explicit selected imports preserve IDs/provenance and treat old completion as history, not fresh verification. No bulk migration or runtime selector in v0.1.

Future delegates submit task-ID/contract-bound proposals and evidence through the same mutation service; they do not independently rewrite authority. No subagents, leases, worktrees, mandatory reviewers, CI service, PR automation, deployment, policy DSL, or autonomous follow-up engine in v0.1.

## Delivery and verification

The workflow contains the only task/dependency/status plan. First prove a one-task bug flow with a real failing check, fix, passing check, completion gate, and restart. Then broaden docket integration, graph/progressive planning, artifacts/context, and qualification.

Use regression/TDD tests for graph/reducer/store/evidence invariants, fault-injection for persistence, integration tests for actual Pi error/permission semantics, keyboard/UI tests for docket, and context-budget tests. Run typecheck, focused tests, package checks, and the full suite at qualification. Retire obsolete orchestration expectations explicitly with rationale; never restore obsolete production APIs or silently exclude failing tests just to get green.

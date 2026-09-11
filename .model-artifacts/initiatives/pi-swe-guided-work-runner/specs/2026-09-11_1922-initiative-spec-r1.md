# Initiative specification r1: Pi-SWE guided work runner

- Topic: `pi-swe-guided-work-runner`
- Revision: 1
- Created: 2026-09-11
- Status: review-ready
- Predecessor: none

## Problem

`/swe orchestrate` can inspect canonical artifacts and recommend one lifecycle skill, but it is intentionally guidance-only. Operators who explicitly authorize continued work must manually invoke every implementation, verification, review, completion, and next-contract step. Existing lifecycle code already models guarded transitions, stable work state, retry identities, blocked cases, reconstruction, and gate-aware recommendations, but no Pi runtime controller safely turns those decisions into bounded follow-up agent turns.

## Outcome

Add an explicit, resumable `/swe work` runner that can advance one canonical initiative through lifecycle stages without trusting chat memory or model prose. It must execute only after operator authorization, invoke canonical `/skill:swe-*` workflows, re-inspect durable artifacts after every settled turn, validate structured stage checkpoints, and stop at configured scope, budget, safety, approval, ambiguity, or repeated-failure boundaries.

## Observable behavior

1. An operator can inspect, start, resume, pause, or stop a runner for one exact topic.
2. `guided` mode advances safe in-contract stages but pauses for plan approval/replanning, destructive or external side effects, missing capabilities, ambiguous state, conflicting changes, and exhausted retries.
3. `autonomous` mode is available only through explicit invocation and differs solely at documented approval gates; it never bypasses canonical plan, verification, review, completion, or safety validation.
4. `--until contract` stops after the active contract is dispositioned; `--until initiative` may select the next dependency-ready contract and continue until final reconciliation.
5. Every continuation decision is derived from current layout-v2 manifest, approved plan, `contracts.json`, validated checkpoint/evidence artifacts, and persisted runner policy—not prior chat assertions.
6. A crash or session restart can resume the same bounded run without duplicating a dispatched stage or completion transaction.
7. The operator can always stop the loop, and bounded turn/retry/time budgets prevent indefinite self-prompting.

## Users

- Maintainers running multi-contract `pi-swe` initiatives.
- Contributors resuming work in a fresh Pi session.
- Reviewers who need an auditable explanation of why the runner continued, paused, or stopped.

## Constraints

- Preserve `/swe orchestrate` as guidance-only and retain existing command behavior.
- Reuse `recommendGateAwareOrchestration`, lifecycle transition validation, retry evaluation, canonical inspection, and journaled completion rather than introduce a second lifecycle authority.
- Use Pi's documented `sendUserMessage(..., { expandPromptTemplates: true })` and settled-agent lifecycle safely; never recursively dispatch while another turn is active.
- Only one active runner lease may own a topic in a repository/session at a time.
- Persist bounded, versioned runtime state under `.model-artifacts/system/logs/pi-swe/<topic>/`; canonical initiative artifacts remain the source of truth.
- Runner checkpoints and evidence paths must be repository-relative, topic-bound, size-bounded, symlink-safe, and hash-validated.
- Default configuration remains non-autonomous and backward-compatible.
- Each implementation contract should normally touch no more than five production/test documentation paths unless its contract explicitly justifies otherwise.

## Non-goals

- Replacing stage skills with one monolithic prompt.
- Allowing model prose, todo state, filenames, or newest revision numbers to grant readiness.
- Automatically approving a new or materially revised plan.
- Automatically accepting destructive commands, credential use, network spend, deployment, publication, or external-system mutation.
- Parallel execution of contracts or multiple concurrent runner owners.
- A general-purpose agent scheduler outside `pi-swe`.
- Changing canonical stable contract filenames or bypassing `swe_complete` evidence requirements.

## Compatibility

- Existing `/swe status`, `/swe config`, `/swe orchestrate`, `/swe complete`, and `/skill:swe-*` behavior remains valid.
- Repositories without runner state behave exactly as before.
- New config fields receive conservative defaults and older config files remain readable.
- Unknown future runner-state versions fail closed with diagnostics; current writers emit only the new canonical version.

## Security and safety

- Starting or resuming requires an explicit user command; extension startup never silently starts work.
- Generated follow-up prompts contain exact topic, plan revision, contract ID/path/hash, stage, policy, budget, and required reads.
- Dispatch tokens make each stage attempt idempotent and reject stale or duplicate checkpoints.
- Tool-side checkpoint validation rejects path escape, symlink traversal, oversized payloads, stale contract identity, or invalid transitions.
- Guided and autonomous modes both stop for unsafe operations, external side effects, missing verifier, ambiguous initiative, stale approval, scope drift, conflicting changes, or human-only decisions.
- The command exposes immediate pause/stop controls and emits a durable blocked handoff.

## Migration and rollback

This is additive. Existing repository cursor files are read as before; runner state is optional and versioned separately. Rollback removes the `/swe work` command/tool/event wiring and ignores retained runner logs. No canonical initiative migration is required. A state-version mismatch or partial dispatch record blocks resume rather than guessing.

## Risks

- A follow-up turn may settle without producing a valid stage checkpoint.
- Event ordering may dispatch twice around restart or compaction.
- A model may attempt work beyond the active contract despite prompt boundaries.
- Excessive retries may consume time or provider budget.
- Completion evidence may be current while runner state is stale, or vice versa.
- Pi SDK event semantics may change.

Mitigations are structured validated checkpoints, dispatch tokens, atomic persistence, canonical reinspection, single ownership, bounded budgets, explicit stop cases, compatibility tests, and no automatic material replanning.

## Acceptance criteria

- **AC-01 Command surface:** `/swe work <status|start|resume|pause|stop> [topic]` accepts documented `--mode guided|autonomous`, `--until contract|initiative`, and bounded budget options; invalid or ambiguous input performs no dispatch.
- **AC-02 Conservative authorization:** no work starts on extension load, `guided` is the default, and autonomous continuation requires explicit operator selection for that run.
- **AC-03 Canonical routing:** each dispatched stage is selected from a fresh canonical inspection and names the exact approved plan revision and executable contract; todos and chat cannot override it.
- **AC-04 Structured checkpoints:** a model-callable checkpoint interface validates run ID, dispatch token, topic, stage, plan/contract identity, outcome, and evidence paths before changing runner state.
- **AC-05 Settled-turn continuation:** one and only one next `/skill:swe-*` prompt is queued after a valid checkpoint and settled turn; missing, stale, duplicate, or contradictory checkpoints stop with diagnostics.
- **AC-06 Lifecycle gates:** implementation routes to verification, verification to implementation or review, review to implementation/replan/completion, and completion to contract/initiative stopping according to existing transition and evidence gates.
- **AC-07 Completion integrity:** automatic contract disposition invokes the existing guarded journaled completion path only with passing verification and approving review identities; no lower-level shortcut is added.
- **AC-08 Bounded recovery:** persisted versioned state supports restart/resume without duplicate dispatch; turn, retry, elapsed-time, and optional provider-budget limits produce an actionable blocked/paused handoff.
- **AC-09 Safety stops:** ambiguous initiative, stale plan/hash, dependency block, missing verifier/capability, scope drift, conflicting changes, unsafe operation, external side effect, and user stop all terminate or pause without further prompting.
- **AC-10 Compatibility and documentation:** existing command tests remain green; focused runner tests cover clean contract, initiative continuation, verify-fix loop, review-return-to-plan, duplicate events, crash recovery, and every stop case; README and E2E guidance describe authority and controls.

## Open blockers

- Explicit approval of the reviewed canonical plan is required before implementation.
- No implementation-time external capability is currently missing; authenticated provider/network operations remain runtime human gates if encountered.

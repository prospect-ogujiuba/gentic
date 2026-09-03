# pi-swe

`pi-swe` is a standalone Pi extension for software-engineering workflow guidance. It keeps planning, diagnosis, implementation, verification, review, finalization, TDD, and DSA assessment in one canonical SWE surface.

The extension may read optional peer capabilities such as `pi-todo` when they are present, but peers are not required. It must not import peer internals or legacy workflow internals.

## Anatomy

- **Mode:** `layered`
- **State:** `transitional`
- **Public entry:** `index.ts`
- **Layers:** `config`, `domain`, `app`, `pi`, `resources`
- **Resources:** `docs/`, `skills/`, `references/`, `pi-swe.schema.json`
- **Machine declaration:** optional handwritten `extension.anatomy.json` (not currently present)
- **Reference role:** targeted behavior-preserving declaration; `index.ts` is already a thin adapter.
- **Mismatch notes:** config is folderized under `src/config/`, canonical implementations live under `src/domain/`, `src/app/`, and `src/pi/`, and flat `src/*.ts` compatibility shims remain for existing imports. Top-level docs/skills/references/schema files remain package resources.

## Orientation block

- **What it does:** observes planning/inspection/change/verification signals, maintains per-turn SWE state, issues advisory workflow warnings, exposes SWE status/config, and provides staged SWE skills.
- **Commands/tools it registers:** `/swe status`, `/swe config`, guidance-only `/swe orchestrate`, and explicit guarded `/swe complete`; no model-callable tool is registered by `pi-swe`. Stage guidance is discovered natively from `skills/` and invoked as `/skill:swe-*`.
- **Pi events it listens to:** `session_start` loads config and reconstructs active-branch state; `session_tree` reconstructs after navigation; `turn_start` resets turn-local state; `tool_call` classifies inspection/code-change/todo-completion facts; `tool_result` classifies verification facts; `agent_settled` persists required cross-turn state; `session_shutdown` clears runtime state.
- **State/config files it reads/writes:** reads project `.pi/pi-swe.json`, global `~/.pi/agent/pi-swe.json`, defaults, and `pi-swe.schema.json`; persists only active plan/stage in versioned `gentic.swe.state` custom entries and reconstructs them from `sessionManager.getBranch()`; inspected/changed paths, warnings, peer context, and verification evidence remain turn-local.
- **Internal module map:** `index.ts` wires events and `/swe`; `src/config/` loads config; `src/domain/classify.ts` extracts workflow facts; `src/domain/state.ts` tracks active plan, inspected/changed paths, and verification; `src/domain/policy.ts` evaluates advisory warnings; `src/capabilities.ts` reads optional peer capability surfaces; `src/domain/evidence.ts`, `src/domain/tdd.ts`, and `src/domain/dsa.ts` hold focused helpers; `docs/`, `skills/`, and `references/` provide resource guidance.
- **Tests to run:** `npm run test:swe` for the focused pi-swe suite, `npm run check` for package/anatomy discovery, or the full `npm test` suite when broader regression risk justifies it.
- **Known boundaries/non-goals:** guidance is advisory unless config disables/enables checks; it does not import peer internals, replace explicit read-before-edit discipline, or reintroduce legacy `/sop`, `/tdd-rgr`, or `/dsa-advisor` surfaces.

## Runtime lifecycle contract

| Pi lifecycle event | pi-swe behavior |
|---|---|
| `session_start` | Load config/capabilities and decode required state from the active branch. |
| `session_tree` | Reconstruct from the selected branch; abandoned branch state is ignored. |
| `session_info_changed` | Refresh peer/session-derived context. |
| `turn_start` | Clear inspected paths, changed paths, verification evidence, and warnings while preserving active plan/stage. |
| `agent_settled` | Append a version-1 active plan/stage snapshot when state exists. |
| `session_shutdown` | Clear runtime state and advisory UI. |

Unknown future state-envelope versions are ignored. Failed commands, notes/manual evidence, and successful `nearby` checks remain visible evidence but do not satisfy final verification; only successful `focused` or `broad` command evidence clears `missing_verification`.

## Commands

`pi-swe` owns the `/swe` runtime command namespace:

```text
/swe status
/swe config
/swe orchestrate [status|start|resume|handoff]
/swe complete <topic> <contract-id> <plan-revision> <contract-path> <contract-hash> <verification-path> <verification-hash> <review-path> <review-hash> approve [clear|advance]
```

- `/swe status` reports canonical disposition, phase progress, active/ready contracts, blockers, runtime context, and current warnings.
- `/swe config` reports the effective project/global/default configuration and config diagnostics.
- `/swe orchestrate` is guidance-only: it reports artifact readiness, recommends the next lifecycle step, routes missing verification/review/finalize gates, and emits deterministic exception handoffs without running hidden multi-step work.
- `/swe complete` is the sole mutation action. It validates the exact active plan/contract hash plus passing verification and approving implementation-review identities, then runs the recoverable journaled state transition. Before mutation it losslessly normalizes supported legacy schema-v1 manifest/index metadata; the same transaction writes the canonical schema-v2 contract index, records migration provenance and completion evidence, and advances readiness. Contract IDs remain unchanged and evidence stays bound to the original identity. Ambiguous migration, evidence drift, graph errors, and execution blockers reject before writes with artifact-specific diagnostics. Each report must contain one closed `Pi-SWE-Evidence: {...}` JSON line binding topic, contract ID/path/hash, plan revision, and overall decision; the review line also binds the verification path/hash and zero blocking findings. An owner-token-bound exclusive local claim prevents concurrent writers and every journal/target mutation revalidates it. Claim files are never auto-reaped; after a process crash, recovery reports the exact lock path for explicit removal only after the operator confirms its owner is gone. Exact repeats return `already-complete`; mismatches and unfinished/corrupt recovery state do not write or report success. Canonical filenames stay unchanged.

## Stage skills

Use these canonical Pi skill commands for SWE work:

```text
/skill:swe-plan       Define, design, slice, DoD, and verification target.
/skill:swe-diagnose   Reproduce, minimise, hypothesise, instrument, fix, regression-test.
/skill:swe-implement  Implement the smallest honest vertical slice from an assigned file or plan.
/skill:swe-verify     Compile, run, test, and record verification evidence.
/skill:swe-review     Review correctness, hardening, cleanup, verification fit, and residual risk.
/skill:swe-finalize   Summarize behavior, changed files, verification, and follow-up guidance.
/skill:swe-tdd        Red/Green/Refactor for the next observable behavior.
/skill:swe-dsa        Data-structure and algorithm assessment with validation plan.
/skill:swe-orchestrate Sequence lifecycle stages from artifacts and handoff gates.
```

Matching skills live under `extensions/pi-swe/skills/swe-*/SKILL.md`. Compact references live under `extensions/pi-swe/references/`.

## Canonical plans and revisions

For non-trivial work, canonical authority starts at the schema-v1 `.model-artifacts/specs/<topic>/manifest.json`. The manifest points to the active specification and `activePlan`; the active plan points to its revision-specific `contractRoot`, where canonical schema-v2 `contracts.json` indexes phase and subphase contracts. Readers accept supported legacy schema-v1 metadata variants, but all new or migrated index writes use schema v2. Todo may link approved work, but neither a todo nor a filename selects an executable revision.

Before implementation:

1. Follow `manifest.activePlan`, not the highest `rN` filename.
2. Confirm `manifest.approval` is `approved` and matches the exact active plan revision, path, and `contentHash`.
3. Read `<activePlan.contractRoot>/contracts.json` and validate its contract paths, hashes, dependencies, blockers, readiness facts, and planned verification.
4. If `manifest.activeContract` exists and remains valid, execute that exact contract. Otherwise execute the lowest dependency-satisfied pending subphase. Phase entries are non-executable grouping nodes and cannot preempt a ready child.
5. Preserve contracts already marked `complete`; derive phase completion from child dispositions so a newer approved revision does not restart completed work.

Normal contract completion does not create a plan revision. Completion updates canonical machine state and evidence while stable contract filenames remain unchanged. A new immutable revision is created during planning or replanning only when findings require a material plan change—for example scope, architecture, contract requirements, dependency order, verification, migration, or rollback changes. Stop execution, revise, review, and approve that new revision before continuing. Draft, reviewing, numerically newest, or unapproved revisions are not executable.

## Structured lifecycle

Use `pi-swe` as a phase-gated lifecycle. Each stage should leave enough durable evidence for the next stage to continue without relying on chat memory.

1. **Diagnose when behavior is broken or unclear** — `/skill:swe-diagnose`
   - Reproduce the symptom, minimize the failing scope, inspect relevant code/config/logs, list hypotheses with falsifiers, instrument only when needed, and name the smallest credible fix slice.
   - Durable output when non-trivial: `.model-artifacts/findings/<topic>/...` or a diagnosis artifact referenced by the active todo.

2. **Plan before non-trivial changes** — `/skill:swe-plan`
   - Define outcome, constraints, non-goals, phase order, acceptance criteria, and verification targets.
   - Durable output: `.model-artifacts/specs/<topic>/manifest.json`, immutable spec and plan-index revisions, and revision-specific phase/subphase contracts indexed by `contracts.json` under `.model-artifacts/plans/<topic>/revisions/rN/`.

3. **Use TDD when the next behavior should be proven first** — `/skill:swe-tdd`
   - Add one failing test for the next observable behavior, make the smallest production change, then refactor only after green.
   - TDD can replace or precede `/skill:swe-implement` for a narrow behavior slice; it does not expand contract scope.

4. **Implement one approved contract** — `/skill:swe-implement`
   - Resolve the manifest-approved active revision and its contract index, then read `activeContract` or the lowest dependency-satisfied pending contract before editing.
   - Restate intended behavior and verification, edit only required paths, and stop at a verifiable boundary. Material scope or design drift returns to planning for a new reviewed and approved revision; never edit the approved contract in place.

5. **Verify before claiming completion** — `/skill:swe-verify`
   - Run focused tests/checks first, then broader checks as risk requires. Record command/manual evidence and known gaps.
   - Durable output for non-trivial verification: `.model-artifacts/reports/<topic>/...`.

6. **Review after implementation or before handoff** — `/skill:swe-review`
   - Compare the diff to the intended slice, check correctness/hardening/cleanup/security/performance/UX risks, and decide: approve, request changes, or return to plan.
   - Durable output for substantial reviews: `.model-artifacts/reports/<topic>/...`.

7. **Orchestrate across artifacts when resuming or handing off** — `/skill:swe-orchestrate` and `/swe orchestrate`
   - Inspect work orders, todo context when available, and model artifacts; choose the next lifecycle stage; route back to verification/review when gates are missing; or emit an exception handoff.
   - The orchestrator composes existing stage skills and does not replace their instructions or execute hidden work.

8. **Finalize the handoff** — `/skill:swe-finalize`
   - Summarize what changed, why, key paths, verification evidence, review decision, residual risks, and next action such as commit/PR/release or return-to-plan.
   - Durable output for larger handoffs: `.model-artifacts/reports/<topic>/...`.

Optional `/skill:swe-dsa` fits before planning or implementation whenever representation, access patterns, complexity, memory, ordering, persistence, or migration risk materially affect the slice. Its decision and validation plan should be incorporated into the relevant plan revision and implementation contract.

Lifecycle gates:

- Do not implement while diagnosing or planning.
- Do not execute a revision merely because it has the highest number; require the exact manifest approval.
- Do not broaden an implementation beyond the approved contract; material drift returns to planning.
- Do not finalize without verification evidence or an explicit verification gap.
- Prefer durable artifacts for multi-step work so plan → implement → verify → review → finalize remains traceable.

## Command examples

Plan and implement a scoped change:

```text
/skill:swe-plan Add a cache for repeated project metadata reads. Define intended behavior, file scope, acceptance criteria, and verification target.
/skill:swe-implement Implement the manifest-approved active contract. Validate its revision, hash, dependencies, and verification target; edit only named targets and stop at a verifiable boundary.
/skill:swe-verify Run the planned focused test/check command and report evidence.
/skill:swe-finalize Summarize behavior, changed files, verification evidence, and follow-up gaps.
```

Diagnose and fix with TDD:

```text
/skill:swe-diagnose Diagnose this failing command before editing: npm test -- test/project-cache.test.ts
/skill:swe-tdd Add one failing regression test, make the smallest production fix, refactor only after green, and name verification.
/skill:swe-review Review the fix for correctness and residual risk.
```

Assess a DSA choice before implementation:

```text
/skill:swe-dsa Assess whether this lookup should remain an array scan or move to a Map. Include access patterns, complexity, memory tradeoff, migration risk, rejected alternatives, and validation plan.
```

## End-to-end scenarios

Manual end-to-end scripts live in [`docs/e2e-scenarios.md`](docs/e2e-scenarios.md):

The guide covers canonical plan approval and revision selection, implementation/verification/review/finalization, diagnosis/TDD, DSA, standalone and optional-todo operation, orchestration, resume, blocked handoff, reviewed completion/recovery, stale approval, legacy adoption, multi-initiative ambiguity, approved deferral, and stable-filename status projection.

These scenarios are executable by a new contributor from a fresh Pi session. Their checklist is verification guidance, not authority to mark an initiative complete; canonical completion still requires the manifest, contract index, evidence, review, and finalization gates.

## Optional peer behavior

`pi-swe` is standalone:

- With no peers installed, stage skills work from the user-provided context. `/swe status` may report `detected peers: none`, `active plan: none`, `todo scope: none`, and `todo evidence count: 0`.
- With `pi-todo` installed, `pi-swe` may summarize the active todo, todo scope, and todo evidence through public capability surfaces. This context enriches status and policy hints; it does not replace read-before-edit, narrow scope, or verification requirements.
- Other peers such as `pi-permission-system` may be detected for status only unless they expose explicit public capabilities.

## Configuration

Config is loaded from project, global, then defaults. The schema is `extensions/pi-swe/pi-swe.schema.json`.

```json
{
  "version": 1,
  "enabled": true,
  "mode": "advisory",
  "stages": {},
  "surgicalChange": { "maxFiles": 5 }
}
```

`mode` may be `off`, `advisory`, or `enforced`.

## Resource invocation migration

The mirrored `/swe-*` prompt templates were removed. Use the canonical skill commands `/skill:swe-*`; arguments after the command are appended to the loaded skill. Runtime `/swe status`, `/swe config`, and guidance-only `/swe orchestrate` remain; `/swe complete` is a narrowly guarded canonical disposition action, not a prompt alias or autonomous runner.

### Programming SOP → pi-swe stages

Legacy Programming SOP spread guidance across define/design/develop/verify/harden/explain/maintain/reflect surfaces and `/sop`-style runtime concepts. In `pi-swe`, the canonical replacement is the staged SWE path:

- define/design/slice → `/skill:swe-plan`
- develop → `/skill:swe-implement`
- verify → `/skill:swe-verify`
- harden/review → `/skill:swe-review`
- explain/reflect/hand off → `/skill:swe-finalize`
- bug-first work → `/skill:swe-diagnose`

Use the exact contract selected through the manifest-approved active revision as the implementation contract. Todo may link that contract but cannot replace its approval, path, or hash. Do not call legacy `programming_sop` tools or `/sop` namespaces for core `pi-swe` work.

### TDD RGR → `/skill:swe-tdd`

Legacy TDD RGR exposed a `/tdd-rgr` prompt/command and `tdd_rgr` coaching tool. In `pi-swe`, TDD is guidance-only through `/skill:swe-tdd`, its skill, and compact references under `references/tdd-rgr/`.

Use `/skill:swe-tdd` when the slice needs Red → Green → Refactor discipline: one failing test, smallest production change, refactor only after green, and explicit verification evidence.

### DSA Advisor → `/skill:swe-dsa`

Legacy DSA Advisor exposed `/dsa-advisor`, `dsa_advisor`, assessment state, catalogs, and detailed advisor machinery. In `pi-swe`, DSA assessment is implementation-aware SWE guidance through `/skill:swe-dsa`, its skill, and compact references under `references/dsa/`.

Use `/skill:swe-dsa` when representation, access patterns, complexity, memory, ordering, persistence, migration risk, or validation strategy matter.

## Intentionally omitted legacy surfaces

`pi-swe` intentionally does not reintroduce:

- `/sop`, `/programming-sop`, or `programming_sop` namespaces.
- `/tdd-rgr` command/prompt or `tdd_rgr` model-callable tool.
- `/dsa-advisor` command/prompt, `dsa_advisor` model-callable tool, legacy assessment state, or large generated data-structure catalogs.
- Direct imports from legacy extensions or peer extension internals.
- Mandatory `pi-todo` coupling.

These omissions keep `pi-swe` small, standalone, and focused on SWE workflow discipline instead of legacy extension architecture.

## Complete-version status

The complete-version verification checklist is documented in [`docs/e2e-scenarios.md`](docs/e2e-scenarios.md#complete-version-checklist). Passing that checklist supports verification but does not itself complete a canonical initiative; the active manifest and contracts remain authoritative. Deferred refactor cleanup, including flat compatibility shim retirement, is tracked in `.model-artifacts/reports/pi-swe-standard-extension-refactor/2026-05-14_2044-phase-06-deferred-cleanup.md`; future work should be treated as enhancement scope.

# pi-swe

`pi-swe` is a standalone Pi extension for software-engineering workflow guidance. It keeps planning, diagnosis, implementation, verification, review, finalization, TDD, and DSA assessment in one canonical SWE surface.

The extension may read optional peer capabilities such as `pi-todo` when they are present, but peers are not required. It must not import peer internals or legacy workflow internals.

## Anatomy

- **Mode:** `layered`
- **State:** `transitional`
- **Public entry:** `index.ts`
- **Layers:** `config`, `domain`, `app`, `pi`, `resources`
- **Resources:** `skills/`, `prompts/`, `pi-swe.schema.json`
- **Machine declaration:** `extension.anatomy.json`
- **Reference role:** targeted behavior-preserving declaration; `index.ts` is already a thin adapter.
- **Mismatch notes:** layer roles are not yet folderized. `config.ts` handles config, `classify.ts`/`policy.ts`/`state.ts` hold domain and app logic, `commands.ts`/`events.ts` wire Pi runtime behavior, and skills/prompts/schema files are package resources.

## Orientation block

- **What it does:** observes planning/inspection/change/verification signals, maintains per-turn SWE state, issues advisory workflow warnings, exposes SWE status/config, and provides staged SWE prompts/skills.
- **Commands/tools it registers:** `/swe status` and `/swe config`; no model-callable tool is registered by `pi-swe`. Prompt templates such as `/swe-plan`, `/swe-implement`, and `/swe-verify` are package resources discovered from `prompts/`.
- **Pi events it listens to:** `session_start` loads config and resets runtime state; `turn_start` resets turn state; `tool_call` classifies inspection/code-change/todo-completion facts; `tool_result` classifies verification facts.
- **State/config files it reads/writes:** reads project `.pi/pi-swe.json`, global `~/.pi/agent/pi-swe.json`, defaults, and `pi-swe.schema.json`; keeps runtime state, warnings, peer context, and verification evidence in memory; writes no state file.
- **Internal module map:** `index.ts` wires events and `/swe`; `src/config.ts` loads config; `src/classify.ts` extracts workflow facts; `src/state.ts` tracks active plan, inspected/changed paths, and verification; `src/policy.ts` evaluates advisory warnings; `src/capabilities.ts` reads optional peer capability surfaces; `src/evidence.ts`, `src/tdd.ts`, and `src/dsa.ts` hold focused helpers; `prompts/`, `skills/`, and `references/` provide stage guidance.
- **Tests to run:** `npm test -- test/pi-swe.test.ts test/pi-swe-capabilities.test.ts test/pi-swe-classify.test.ts test/pi-swe-config.test.ts test/pi-swe-helpers.test.ts test/pi-swe-policy.test.ts test/pi-swe-state.test.ts` or the full `npm test` suite.
- **Known boundaries/non-goals:** guidance is advisory unless config disables/enables checks; it does not import peer internals, replace explicit read-before-edit discipline, or reintroduce legacy `/sop`, `/tdd-rgr`, or `/dsa-advisor` surfaces.

## Commands

`pi-swe` owns the `/swe` runtime command namespace:

```text
/swe status
/swe config
```

- `/swe status` reports enablement, mode, config source, detected optional peers, active plan, todo scope/evidence when available, inspected/changed path counts, verification count, and current warnings.
- `/swe config` reports the effective project/global/default configuration and config diagnostics.

## Stage prompts and skills

Use these prompt templates for SWE work:

```text
/swe-plan       Define, design, slice, DoD, and verification target.
/swe-diagnose   Reproduce, minimise, hypothesise, instrument, fix, regression-test.
/swe-implement  Implement the smallest honest vertical slice from an assigned file or plan.
/swe-verify     Compile, run, test, and record verification evidence.
/swe-review     Review correctness, hardening, cleanup, verification fit, and residual risk.
/swe-finalize   Summarize behavior, changed files, verification, and follow-up guidance.
/swe-tdd        Red/Green/Refactor for the next observable behavior.
/swe-dsa        Data-structure and algorithm assessment with validation plan.
```

Matching skills live under `extensions/pi-swe/skills/swe-*/SKILL.md`. Compact references live under `extensions/pi-swe/references/`.

## Structured lifecycle

Use `pi-swe` as a phase-gated lifecycle. Each stage should leave enough durable evidence for the next stage to continue without relying on chat memory.

1. **Diagnose when behavior is broken or unclear** — `/swe-diagnose`
   - Reproduce the symptom, minimize the failing scope, inspect relevant code/config/logs, list hypotheses with falsifiers, instrument only when needed, and name the smallest credible fix slice.
   - Durable output when non-trivial: `.model-artifacts/findings/<topic>/...` or a diagnosis artifact referenced by the active todo.

2. **Plan before non-trivial changes** — `/swe-plan`
   - Define outcome, constraints, non-goals, phase order, acceptance criteria, and verification targets.
   - Durable output: editable phase files under `.model-artifacts/todo/<topic>/phases/`; each phase is an implementation contract.

3. **Use TDD when the next behavior should be proven first** — `/swe-tdd`
   - Add one failing test for the next observable behavior, make the smallest production change, then refactor only after green.
   - TDD can replace or precede `/swe-implement` for a narrow behavior slice; it does not expand phase scope.

4. **Implement one assigned slice** — `/swe-implement`
   - Read the assigned phase/todo/plan file first, restate intended behavior and verification target, edit only the required paths, and stop at a verifiable boundary.
   - Scope drift must be made visible through a note, phase update, or return to planning.

5. **Verify before claiming completion** — `/swe-verify`
   - Run focused tests/checks first, then broader checks as risk requires. Record command/manual evidence and known gaps.
   - Durable output for non-trivial verification: `.model-artifacts/verification/<topic>/...`.

6. **Review after implementation or before handoff** — `/swe-review`
   - Compare the diff to the intended slice, check correctness/hardening/cleanup/security/performance/UX risks, and decide: approve, request changes, or return to plan.
   - Durable output for substantial reviews: `.model-artifacts/review/<topic>/...`.

7. **Finalize the handoff** — `/swe-finalize`
   - Summarize what changed, why, key paths, verification evidence, review decision, residual risks, and next action such as commit/PR/release or return-to-plan.
   - Durable output for larger handoffs: `.model-artifacts/finalize/<topic>/...`.

Optional `/swe-dsa` fits before planning or implementation whenever representation, access patterns, complexity, memory, ordering, persistence, or migration risk materially affect the slice. Its decision and validation plan should feed the phase file or implementation contract.

Lifecycle gates:

- Do not implement while diagnosing or planning.
- Do not broaden an implementation beyond the assigned phase file without recording scope drift.
- Do not finalize without verification evidence or an explicit verification gap.
- Prefer durable artifacts for multi-step work so plan → implement → verify → review → finalize remains traceable.

## Command examples

Plan and implement a scoped change:

```text
/swe-plan Add a cache for repeated project metadata reads. Define intended behavior, file scope, acceptance criteria, and verification target.
/swe-implement Implement the assigned plan file. Read it first, edit only named targets, and stop at a verifiable boundary.
/swe-verify Run the planned focused test/check command and report evidence.
/swe-finalize Summarize behavior, changed files, verification evidence, and follow-up gaps.
```

Diagnose and fix with TDD:

```text
/swe-diagnose Diagnose this failing command before editing: npm test -- test/project-cache.test.ts
/swe-tdd Add one failing regression test, make the smallest production fix, refactor only after green, and name verification.
/swe-review Review the fix for correctness and residual risk.
```

Assess a DSA choice before implementation:

```text
/swe-dsa Assess whether this lookup should remain an array scan or move to a Map. Include access patterns, complexity, memory tradeoff, migration risk, rejected alternatives, and validation plan.
```

## End-to-end scenarios

Manual end-to-end scripts live in [`docs/e2e-scenarios.md`](docs/e2e-scenarios.md):

1. plan → implement → verify → finalize.
2. diagnose bug → TDD fix → verify → review.
3. DSA assessment → implementation → validation.
4. no `pi-todo` installed.
5. `pi-todo` installed with active task/evidence.

These scenarios are executable by a new contributor from a fresh Pi session and are the complete-version smoke checklist for Phase 12.

## Optional peer behavior

`pi-swe` is standalone:

- With no peers installed, stage prompts work from the user-provided context. `/swe status` may report `detected peers: none`, `active plan: none`, `todo scope: none`, and `todo evidence count: 0`.
- With `pi-todo` installed, `pi-swe` may summarize the active todo, todo scope, and todo evidence through public capability surfaces. This context enriches status and policy hints; it does not replace read-before-edit, narrow scope, or verification requirements.
- Other peers such as `pi-gate` may be detected for status only unless they expose explicit public capabilities.

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

## Migration from legacy concepts

### Programming SOP → pi-swe stages

Legacy Programming SOP spread guidance across define/design/develop/verify/harden/explain/maintain/reflect surfaces and `/sop`-style runtime concepts. In `pi-swe`, the canonical replacement is the staged SWE path:

- define/design/slice → `/swe-plan`
- develop → `/swe-implement`
- verify → `/swe-verify`
- harden/review → `/swe-review`
- explain/reflect/hand off → `/swe-finalize`
- bug-first work → `/swe-diagnose`

Use assigned plan/phase/todo files as implementation contracts. Do not call legacy `programming_sop` tools or `/sop` namespaces for core `pi-swe` work.

### TDD RGR → `/swe-tdd`

Legacy TDD RGR exposed a `/tdd-rgr` prompt/command and `tdd_rgr` coaching tool. In `pi-swe`, TDD is guidance-only through `/swe-tdd`, its skill, and compact references under `references/tdd-rgr/`.

Use `/swe-tdd` when the slice needs Red → Green → Refactor discipline: one failing test, smallest production change, refactor only after green, and explicit verification evidence.

### DSA Advisor → `/swe-dsa`

Legacy DSA Advisor exposed `/dsa-advisor`, `dsa_advisor`, assessment state, catalogs, and detailed advisor machinery. In `pi-swe`, DSA assessment is implementation-aware SWE guidance through `/swe-dsa`, its skill, and compact references under `references/dsa/`.

Use `/swe-dsa` when representation, access patterns, complexity, memory, ordering, persistence, migration risk, or validation strategy matter.

## Intentionally omitted legacy surfaces

`pi-swe` intentionally does not reintroduce:

- `/sop`, `/programming-sop`, or `programming_sop` namespaces.
- `/tdd-rgr` command/prompt or `tdd_rgr` model-callable tool.
- `/dsa-advisor` command/prompt, `dsa_advisor` model-callable tool, legacy assessment state, or large generated data-structure catalogs.
- Direct imports from legacy extensions or peer extension internals.
- Mandatory `pi-todo` coupling.

These omissions keep `pi-swe` small, standalone, and focused on SWE workflow discipline instead of legacy extension architecture.

## Complete-version status

Phase 12 complete-version definition of done is documented in [`docs/e2e-scenarios.md`](docs/e2e-scenarios.md#complete-version-checklist). Remaining core-completion gaps: none known; future work should be treated as enhancement scope.

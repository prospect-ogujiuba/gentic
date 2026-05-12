# pi-swe

`pi-swe` is a standalone Pi extension for software-engineering workflow guidance. It keeps planning, diagnosis, implementation, verification, review, finalization, TDD, and DSA assessment in one canonical SWE surface.

The extension may read optional peer capabilities such as `pi-todo` when they are present, but peers are not required. It must not import peer internals or legacy workflow internals.

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

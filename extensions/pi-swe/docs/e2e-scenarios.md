# pi-swe end-to-end scenarios

These scripts are manual end-to-end checks for a contributor running Pi from the repository root. They prove that `pi-swe` works as a standalone workflow extension and that optional peers such as `pi-todo` only enrich context.

Before each scenario, start a fresh Pi session in this repository and run:

```text
/swe status
/swe config
```

Expected baseline:

- `/swe status` reports `enabled: true`, the current mode, detected peers, active plan, inspected/changed path counts, and verification counts.
- `/swe config` reports the effective defaults or project/global config.
- If no peer extension is installed, `detected peers: none` and `active plan: none` are valid.

## Scenario 1: plan → implement → verify → finalize

Goal: exercise the normal Programming SOP replacement path without legacy `/sop` commands.

1. Ask Pi:

   ```text
   /swe-plan Add a small user-visible behavior. Define the intended behavior, file scope, acceptance criteria, and verification target. Produce a narrow implementation slice.
   ```

2. Save the plan as the assigned slice or point `/swe-implement` at the existing assigned file.
3. Ask Pi:

   ```text
   /swe-implement Implement the assigned slice. Read the slice first, edit only the named target files, and stop at a verifiable boundary.
   ```

4. Ask Pi:

   ```text
   /swe-verify Verify the slice with the planned command and report evidence only for the changed scope.
   ```

5. Ask Pi:

   ```text
   /swe-finalize Summarize behavior, changed files, verification evidence, and any follow-up gaps.
   ```

Expected result: `pi-swe` warnings, if any, are about inspection/scope/verification discipline; no legacy `programming_sop` tool or `/sop` namespace is required.

## Scenario 2: diagnose bug → TDD fix → verify → review

Goal: exercise diagnosis discipline and Red/Green/Refactor guidance before implementation.

1. Ask Pi:

   ```text
   /swe-diagnose Diagnose this failing behavior before editing: <paste minimal failure, command, or stack trace>. Reproduce, minimise, hypothesise, instrument, then name the smallest fix slice.
   ```

2. Ask Pi:

   ```text
   /swe-tdd Use Red/Green/Refactor for the next observable behavior from the diagnosis. Add one failing test first, make the smallest production change, refactor only after green, and name the verification command.
   ```

3. Ask Pi:

   ```text
   /swe-verify Run the focused test and any required compile/check command for this fix.
   ```

4. Ask Pi:

   ```text
   /swe-review Review the diff for correctness, hardening, cleanup, verification fit, and residual risk.
   ```

Expected result: the workflow uses `/swe-diagnose` and `/swe-tdd`; it does not require the legacy `/tdd-rgr` command or `tdd_rgr` tool.

## Scenario 3: DSA assessment → implementation → validation

Goal: exercise DSA Advisor replacement guidance as part of implementation planning.

1. Ask Pi:

   ```text
   /swe-dsa Assess the data-structure and algorithm choice for <target behavior>. Include current representation, access patterns, complexity, memory tradeoffs, migration risk, rejected alternatives, and validation plan.
   ```

2. If the recommendation says to change code, ask Pi:

   ```text
   /swe-implement Implement only the chosen DSA slice and keep API behavior aligned with the validation plan.
   ```

3. Ask Pi:

   ```text
   /swe-verify Run the validation plan, including complexity/performance checks if the DSA assessment required them.
   ```

Expected result: the DSA decision is documented in the slice/final response; no legacy `/dsa-advisor` command or `dsa_advisor` tool is required.

## Scenario 4: no `pi-todo` installed

Goal: prove `pi-swe` remains standalone.

1. Disable or omit `pi-todo` from the active Pi package set.
2. Start Pi in this repository.
3. Run:

   ```text
   /swe status
   /swe-plan Plan a tiny docs-only change without relying on an active todo.
   ```

Expected result: `/swe status` may show `detected peers: none`, `active plan: none`, `todo scope: none`, and `todo evidence count: 0`; the stage prompts still work from the user-provided context.

## Scenario 5: `pi-todo` installed with active task/evidence

Goal: prove optional peer context enriches, but does not replace, SWE discipline.

1. Enable `pi-todo` and start or claim a task with acceptance criteria, scope files, and at least one evidence entry.
2. Start Pi in this repository and run:

   ```text
   /swe status
   ```

3. Continue with:

   ```text
   /swe-implement Implement the active task's smallest honest slice and keep edits inside the todo scope unless the slice records a scope change.
   /swe-verify Verify the active task and attach or report evidence.
   ```

Expected result: `/swe status` reports `detected peers` including `pi-todo`, an `active plan` sourced from todo, summarized `todo scope`, and `todo evidence count`; `pi-swe` still requires read-before-edit, narrow scope, and verification evidence.

## Complete-version checklist

- [x] Standalone `/swe status` and `/swe config` commands are documented.
- [x] Canonical stage prompts are documented: `/swe-plan`, `/swe-diagnose`, `/swe-implement`, `/swe-verify`, `/swe-review`, `/swe-finalize`, `/swe-tdd`, `/swe-dsa`.
- [x] Normal, diagnosis/TDD, and DSA end-to-end scripts are documented.
- [x] No-`pi-todo` and with-`pi-todo` scenarios are documented.
- [x] Legacy Programming SOP, TDD RGR, and DSA Advisor migration paths are documented in `extensions/pi-swe/README.md`.
- [x] Omitted legacy namespaces and model-callable advisor tools are documented as intentional omissions.
- [x] Remaining core-completion gaps: none known from Phase 12; further changes should be tracked as enhancements.

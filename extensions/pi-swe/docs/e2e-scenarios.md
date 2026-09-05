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

For every canonical scenario, authority starts at schema-v2 `.model-artifacts/initiatives/<topic>/specs/manifest.json`. Layout-v1 authority is inspection-only and migration-required; mixed layout authority blocks. Follow `manifest.activePlan` only when its exact revision, path, and hash match an `approved` approval record (legacy `approve` is normalized to that state). Then read `<activePlan.contractRoot>/contracts.json`; canonical writers emit schema v2, while readers normalize supported legacy schema-v1 variants. Execute `manifest.activeContract` when valid, otherwise the lowest dependency-satisfied pending subphase. Phase entries are non-executable grouping nodes and never preempt ready children. Never select a plan merely because it has the highest revision number.

## Scenario 1: plan → implement → verify → finalize

Goal: exercise the normal Programming SOP replacement path without legacy `/sop` commands.

1. Ask Pi:

   ```text
   /skill:swe-plan Add a small user-visible behavior. Define the intended behavior, file scope, acceptance criteria, verification target, canonical manifest, and narrow implementation contracts.
   ```

2. Review and explicitly approve the exact plan revision. Confirm `manifest.approval` matches `manifest.activePlan`, then read its `contracts.json` and identify the first ready contract.
3. Ask Pi:

   ```text
   /skill:swe-implement Implement the exact manifest-approved active contract. Validate its revision, path, hash, dependencies, and verification target; edit only named files and stop at a verifiable boundary.
   ```

4. Ask Pi:

   ```text
   /skill:swe-verify Verify the slice with the planned command and report evidence only for the changed scope.
   ```

5. Ask Pi:

   ```text
   /skill:swe-finalize Summarize behavior, changed files, verification evidence, and any follow-up gaps.
   ```

Expected result: `pi-swe` warnings, if any, are about inspection/scope/verification discipline; no legacy `programming_sop` tool or `/sop` namespace is required.

## Scenario 2: diagnose bug → TDD fix → verify → review

Goal: exercise diagnosis discipline and Red/Green/Refactor guidance before implementation.

1. Ask Pi:

   ```text
   /skill:swe-diagnose Diagnose this failing behavior before editing: <paste minimal failure, command, or stack trace>. Reproduce, minimise, hypothesise, instrument, then name the smallest fix slice.
   ```

2. Ask Pi:

   ```text
   /skill:swe-tdd Use Red/Green/Refactor for the next observable behavior from the diagnosis. Add one failing test first, make the smallest production change, refactor only after green, and name the verification command.
   ```

3. Ask Pi:

   ```text
   /skill:swe-verify Run the focused test and any required compile/check command for this fix.
   ```

4. Ask Pi:

   ```text
   /skill:swe-review Review the diff for correctness, hardening, cleanup, verification fit, and residual risk.
   ```

Expected result: the workflow uses `/skill:swe-diagnose` and `/skill:swe-tdd`; it does not require the legacy `/tdd-rgr` command or `tdd_rgr` tool.

## Scenario 3: DSA assessment → implementation → validation

Goal: exercise DSA Advisor replacement guidance as part of implementation planning.

1. Ask Pi:

   ```text
   /skill:swe-dsa Assess the data-structure and algorithm choice for <target behavior>. Include current representation, access patterns, complexity, memory tradeoffs, migration risk, rejected alternatives, and validation plan.
   ```

2. If the recommendation says to change code, ask Pi:

   ```text
   /skill:swe-implement Implement only the chosen DSA slice and keep API behavior aligned with the validation plan.
   ```

3. Ask Pi:

   ```text
   /skill:swe-verify Run the validation plan, including complexity/performance checks if the DSA assessment required them.
   ```

Expected result: the DSA decision is documented in the slice/final response; no legacy `/dsa-advisor` command or `dsa_advisor` tool is required.

## Scenario 4: no `pi-todo` installed

Goal: prove `pi-swe` remains standalone.

1. Disable or omit `pi-todo` from the active Pi package set.
2. Start Pi in this repository.
3. Run:

   ```text
   /swe status
   /skill:swe-plan Plan a tiny docs-only change without relying on an active todo.
   ```

Expected result: `/swe status` may show `detected peers: none`, `active plan: none`, `todo scope: none`, and `todo evidence count: 0`; the stage skills still work from the user-provided context.

## Scenario 5: `pi-todo` installed with active task/evidence

Goal: prove optional peer context enriches, but does not replace, SWE discipline.

1. Enable `pi-todo` and start or claim a task with acceptance criteria, scope files, and at least one evidence entry.
2. Start Pi in this repository and run:

   ```text
   /swe status
   ```

3. Continue with:

   ```text
   /skill:swe-implement Implement the active task's smallest honest slice and keep edits inside the todo scope unless the slice records a scope change.
   /skill:swe-verify Verify the active task and attach or report evidence.
   ```

Expected result: `/swe status` reports `detected peers` including `pi-todo`, summarized todo scope, and todo evidence. A todo may supply fallback context or link the selected contract, but when a canonical manifest exists it cannot replace the manifest-approved active revision, contract identity, or readiness gates.

## Scenario 6: Feature orchestration path

Goal: prove `/swe orchestrate` composes the existing feature lifecycle without hidden execution.

1. Create or select a work-order artifact under `.model-artifacts/initiatives/<topic>/specs/...`.
2. Run:

   ```text
   /swe orchestrate start
   ```

3. Follow the recommended sequence: work order → plan → implement → verify → review → finalize → complete.

Expected result: orchestration recommends existing `swe-*` stages and required artifacts; it does not create a new extension, `/swe-auto` namespace, or model-callable tool.

## Scenario 7: Bug orchestration path

Goal: prove bug work routes through diagnosis and TDD when failure behavior is present.

1. Start from a work order or failing behavior summary.
2. Run:

   ```text
   /swe orchestrate start
   ```

3. Follow the recommended sequence: work order with failure → diagnose → tdd → verify → review → finalize → complete.

Expected result: missing reproduction routes to `/skill:swe-diagnose`; the next behavior can route to `/skill:swe-tdd`; verification remains required before finalization.

## Scenario 8: DSA orchestration path

Goal: prove representation-risk work routes through DSA assessment before implementation.

1. Use a plan or work order that names representation, access-pattern, complexity, memory, ordering, persistence, or migration risk.
2. Run:

   ```text
   /swe orchestrate start
   ```

3. Follow the recommended sequence: plan indicates representation risk → dsa-assess → implement → verify → review → finalize.

Expected result: orchestration routes to `/skill:swe-dsa` and records the DSA decision as a finding or plan input before implementation.

## Scenario 9: Exception orchestration path and blocked handoff

Goal: prove blocked cases produce deterministic human handoff instead of an unstructured partial stop.

1. Trigger or simulate a blocked case such as ambiguous intent, unsafe operation, scope drift, missing capability, unreproducible failure, no verifier, repeat failure, conflicting changes, or unknown transition.
2. Run:

   ```text
   /swe orchestrate handoff
   ```

Expected result: the handoff names the blocked case, relevant artifact path, and required human decision; it does not pretend finalization succeeded.

## Scenario 10: Resume orchestration path

Goal: prove an interrupted flow resumes from durable artifacts instead of chat memory.

1. Interrupt after each lifecycle state with stable artifacts present under `.model-artifacts/`.
2. Start a fresh Pi session and run:

   ```text
   /swe orchestrate resume
   ```

Expected result: orchestration reads model artifacts, recommends the next stage from the last durable state, and routes missing evidence back to the required stage.

## Scenario 11: Finalize gate orchestration path

Goal: prove finalization is gated by verification and review evidence.

1. Prepare an implementation artifact without verification evidence.
2. Run:

   ```text
   /swe orchestrate resume
   ```

3. Add verification evidence but omit review for a risky change, then run the command again.

Expected result: missing verification routes to `/skill:swe-verify`; risky unreviewed changes route to `/skill:swe-review`; `/skill:swe-finalize` is recommended only after required gates pass.

## Scenario 12: Reviewed canonical contract completion and recovery

Goal: prove completion uses stable machine state, exact evidence identity, and recoverable persistence.

1. Start one canonical ready contract so `manifest.activeContract` names it and the index status is `in_progress`.
2. Produce a passing verification report and an approving implementation-review report. Each contains one closed `Pi-SWE-Evidence: {...}` JSON line for the exact topic, contract ID/path/hash, and plan revision; verification declares `outcome: pass`/`gaps: none`, while implementation review declares `decision: approve`, zero blockers, and the exact verification path/hash. Compute whole-report sha256 identities plus the unchanged contract-content hash.
3. Call the concise tool with `{ "topic": "<topic>", "contractId": "<id>", "confirm": true, "next": "advance" }`. In disposable copies, omit topic/contract only when exactly one active canonical initiative and `manifest.activeContract` exist; use `next: "clear"`; use `confirm: false`; and add a duplicate current approving review.
4. Confirm valid calls derive all paths/revisions/hashes, delegate once to the guarded transaction, and return bounded structured status. Confirmation refusal occurs before evidence I/O; missing, ambiguous, stale, unsafe, symlinked, or oversized evidence rejects without writes. The tool does not generate evidence or autonomously run verify/review/lifecycle stages.
5. Retain and run the explicit `/swe complete ... approve advance` low-level action with exact plan revision, stable contract path, hashes, and report paths. Include a supported schema-v1 fixture using `dependencies`, `canonicalPath`, legacy statuses/per-entry readiness, derivable subphase parents, `P1`/`P1.1` IDs, `accessibilityUx`, and manifest approval token `approve`.
6. Run `/swe status`, then repeat the identical low-level completion action after reload.
7. In a disposable fixture, interrupt each journal stage and run recovery; corrupt a required pre-validation backup in one case. Also race separate local processes and simulate incomplete, aged-live, dead-owner, and replaced claim-token files; claim files are never auto-reaped.

Expected result: `swe_complete` is an additive fail-closed derivation adapter and `/swe complete` remains the exact manual/recovery interface; both reach the unchanged guarded transaction. One journaled operation losslessly migrates compatible metadata to canonical contract-index schema v2, preserves contract/hash/evidence identities, marks the subphase `complete`, derives phase state, and advances to the next ready subphase rather than its phase. Its stable filename is unchanged, migration provenance and the completion record survive journal cleanup, and the exact low-level repeat returns `already-complete` without writes. Ambiguous legacy metadata reports all bounded artifact-specific diagnostics with zero mutation. Stage recovery either restores verified preimages, finishes committed cleanup, or retains the journal as `blocked-recovery`; it never guesses state or reports false success.

## Scenario 13: Plan review and revision

Goal: prove revisions are created for planning changes, not routine phase progress.

1. Approve plan r1 and complete one contract without changing its approved requirements.
2. Confirm normal contract completion updates machine state and evidence but does not create a plan revision.
3. During the next contract, discover a material plan change such as an incorrect dependency, acceptance criterion, migration rule, or rollback design.
4. Stop implementation, run `/skill:swe-plan`, incorporate the finding into immutable r2, and run plan review.
5. Approve r2 and verify its `contracts.json` preserves completed dispositions from r1.

Expected result: execution resumes from the next ready r2 contract; completed phases do not restart, and r2 is not executable before exact approval.

## Scenario 14: Stale approval rejection

Goal: prove a numerically latest or modified plan cannot execute under stale approval.

1. Create a new plan revision or alter a linked plan artifact without updating the manifest approval and hashes.
2. Run `/swe orchestrate resume` and attempt `/skill:swe-implement`.

Expected result: execution stops with the mismatched revision/path/hash and returns to planning or review. It never falls back to a filename, todo, or earlier approval.

## Scenario 15: Legacy inspection and migration handoff

Goal: prove legacy planning artifacts remain inspection-only and require a separately approved migration rather than silent mixing.

1. Start with a legacy phase tree or todo-linked plan and no canonical manifest.
2. Run `/swe orchestrate start` and follow the migration-required handoff.
3. Do not write a parallel v2 tree; run the separately approved migration workflow when available.

Expected result: status reports legacy mode until migration is complete. Supported schema-v1 machine metadata may be normalized losslessly, but unrelated legacy planning modes are never mixed silently, and canonical writes do not target a todo phase tree.

## Scenario 16: Two initiatives and ambiguity

Goal: prove repository discovery does not guess between multiple canonical initiatives.

1. Create two valid manifests without a valid current cursor or explicit topic selection.
2. Start a fresh session and run `/swe orchestrate resume`.

Expected result: orchestration reports both bounded candidates and requests an exact topic; it performs no implementation or canonical mutation.

## Scenario 17: Approved deferral

Goal: prove deferred work advances only when the exact plan authorizes it.

1. Mark a contract deferred without an approved deferral record and run orchestration.
2. Add the exact plan-approved deferral rationale and disposition, then review and approve the affected revision.
3. Run orchestration again.

Expected result: the first attempt blocks; the approved deferral allows dependency-safe progression while remaining visible for final reconciliation.

## Scenario 18: Stable filename status projection

Goal: prove human-readable progress comes from canonical state rather than renaming contract files.

1. Record the selected contract path before implementation.
2. Complete it through verification, implementation review, and `/swe complete`.
3. Compare the path and run `/swe status`.

Expected result: the filename is unchanged; `contracts.json`, completion records, and status project `complete`, phase progress, and the next ready contract.

## Complete-version checklist

- [x] Standalone `/swe status` and `/swe config` commands are documented.
- [x] Canonical stage skills are documented: `/skill:swe-plan`, `/skill:swe-diagnose`, `/skill:swe-implement`, `/skill:swe-verify`, `/skill:swe-review`, `/skill:swe-finalize`, `/skill:swe-tdd`, `/skill:swe-dsa`.
- [x] Normal, diagnosis/TDD, and DSA end-to-end scripts are documented.
- [x] No-`pi-todo` and with-`pi-todo` scenarios are documented.
- [x] Feature, bug, DSA, exception, resume, and finalize-gate orchestration scenarios are documented.
- [x] `/swe orchestrate [status|start|resume|handoff]` is documented as guidance-only orchestration inside the existing `/swe` namespace.
- [x] Concise `swe_complete` input, exact confirmation, optional inference constraints, fail-closed evidence derivation, and non-autonomous behavior are documented.
- [x] Explicit `/swe complete` machine-state disposition, schema-v1 compatibility migration to contract-index schema v2, reload idempotency, stable canonical filenames, and staged recovery are documented.
- [x] Manifest-approved revision selection, next-contract progression, plan review/revision, stale approval rejection, legacy inspection/migration handoff, two-initiative ambiguity, blocked handoff, and approved deferral are documented.
- [x] Legacy Programming SOP, TDD RGR, and DSA Advisor migration paths are documented in `extensions/pi-swe/README.md`.
- [x] Omitted legacy namespaces and model-callable advisor tools are documented as intentional omissions.
- [x] The checklist is verification guidance; canonical completion still requires exact manifest, contract, evidence, review, and finalization state.

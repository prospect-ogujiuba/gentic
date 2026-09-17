# SWE production rollout completion session prompts

## Purpose

Use these prompts in separate fresh Pi sessions to complete `swe-production-rollout` without relying on the new `/swe` runtime before it is qualified. Execute them in order. The canonical requirements remain `.model-artifacts/initiatives/swe-production-rollout/workflow.json`; this document does not replace or mutate that authority.

Approved plan anchor: `e882cd62deb541aa437c16c72781a1ccd243055e`  
Bootstrap implementation: `194b672815dd2f04283d8a39fba7c8f87bc01cae`

## Global rules for every session

- Start from a clean checkout whose history contains `194b672815dd2f04283d8a39fba7c8f87bc01cae`.
- Do not use `/swe` until the default-v2 self-hosting handoff has completed and the new runtime has reclaimed authority.
- Never edit `swe-production-rollout/workflow.json` manually. Use only implemented authorized reducer/service events when lifecycle adoption becomes available.
- Work strictly in the current task's `writeScope`; stop for a scope correction rather than editing elsewhere.
- Preserve user changes and migration/rollback evidence. Never delete retained workspaces, receipts, ledgers, or historical artifacts.
- Production activation, live migration, rollback-window closure, real-model execution, push, publish, deployment, and release each require separate explicit user authorization.
- Use TDD where the task requires it. Run every declared verification command plus `git diff --check`.
- Before committing, run `git status --short`, review the exact diff, stage only task files, and use a concise lowercase work-type commit message. Do not push.
- If any required check fails, do not claim completion. Record the exact blocker and stop.

## Gate 0 — reconcile the inherited full-suite blocker

The bootstrap handoff recorded one failure in `test/package-resources.test.ts`: the assertion rejects the already-packaged `skills/swe-orchestration/SKILL.md`. The relevant package/test/skill files were unchanged from `e882cd6`, but the final release contract requires a clean full suite.

### Prompt 0A — diagnosis only

```text
Work in /home/priz/projects/gentic outside /swe. Start from a clean descendant of bootstrap commit 194b672815dd2f04283d8a39fba7c8f87bc01cae. Diagnose the isolated failure in test/package-resources.test.ts where the packaged swe-orchestration skill makes the assertion at line 31 fail.

Do not edit files, workflow state, or Git history. Determine whether the test assertion, package resource manifest, or skill packaging policy is stale. Compare against e882cd6, package.json, package-resource validation code, and current docs. Return:
1. root cause;
2. the smallest correct write scope;
3. exact tests/checks;
4. whether the fix changes public packaging behavior;
5. a proposed one-line commit message.
Stop without patching.
```

### Prompt 0B — authorized prerequisite fix

Replace `<AUTHORIZED_PATHS>` with the paths explicitly approved after Prompt 0A. Do not run this prompt with the placeholder unchanged.

```text
Work in /home/priz/projects/gentic outside /swe. The user explicitly authorizes this prerequisite scope correction: <AUTHORIZED_PATHS>.

Apply the smallest correct fix for the diagnosed package-resource assertion. Do not alter swe-production-rollout/workflow.json or broaden scope. Prove the intended package-resource behavior rather than weakening validation. Run the focused package-resource test, npm test, npm run check, npm run typecheck, and git diff --check. If all pass, commit only the authorized paths with the approved concise commit message. Do not push. If any check fails or the required fix exceeds the authorized paths, stop and report the blocker without committing.
```

## Session 1 — `cutover-readiness`

```text
Implement only task cutover-readiness from .model-artifacts/initiatives/swe-production-rollout/workflow.json, outside /swe and in dependency order. Confirm HEAD contains bootstrap commit 194b672815dd2f04283d8a39fba7c8f87bc01cae and Gate 0 is resolved. Do not modify workflow state or runtime selection.

Stay within:
- extensions/pi-swe/src/cutover.ts
- scripts/release-verify.ts
- test/pi-swe-cutover.test.ts
- docs/release.md

Build a deterministic, read-only readiness check that separately reports code, repository-migration, runtime-activation, and external-release authorization readiness. Require the exact gates in the canonical task, fail closed with bounded output and one next action, and document rollback criteria, retention, decision owner, and evidence. A passing result is evidence only, never activation authorization.

Use TDD. Run:
- node --experimental-strip-types --test test/pi-swe-cutover.test.ts
- npm run typecheck
- git diff --check

Also run any directly affected release-verification tests. If green, commit only task files as `feat: add swe cutover readiness gates`. Do not push, migrate workflows, or change the runtime default.
```

## Session 2 — independent readiness review

```text
Independently review the cutover-readiness commit outside /swe. Do not modify files or workflow state. Inspect the complete diff from the prior commit and adversarially test: false-positive readiness, active workflow/todo ownership, recovery records, unsupported Pi/Node versions, dirty state, missing release checks, stale authorization, bounded output, and no-write failure paths.

Run the task's declared verification and git diff --check. Return blocking findings with exact file/line evidence and a minimal remediation scope. If there are no blockers, explicitly state that readiness evidence is not cutover authorization. Do not commit or push.
```

If blockers exist, feed them to a fresh remediation session constrained to Session 1's write scope, rerun Session 2, and continue only after approval.

## Session 3 — `cutover-rehearsal`

```text
Implement only task cutover-rehearsal from .model-artifacts/initiatives/swe-production-rollout/workflow.json, outside /swe. Require the reviewed cutover-readiness commit as the immediate dependency. Do not touch the live repository workflow set or production runtime selector.

Stay within:
- extensions/pi-swe/src/cutover.ts
- test/pi-swe-cutover.test.ts
- test/fixtures/pi-swe-cutover/**
- scripts/release-verify.ts

Create a disposable-checkout rehearsal that covers every supported migration fixture, temporary v2 entrypoint activation, a complete multi-task lifecycle, parent restart/resume, final acceptance, rollback before and after runtime selection, and exact recovery of workflow bytes, receipts, workspaces, and accepted evidence. Conflicted/unsupported topics must remain byte-identical and produce one exact remediation action. Prove the control checkout and external systems are untouched.

Run:
- node --experimental-strip-types --test test/pi-swe-cutover.test.ts test/pi-swe-migration.test.ts test/pi-swe-runtime.test.ts
- npm run typecheck
- git diff --check

If green, commit only task files as `test: add reversible swe cutover rehearsal`. Do not push, migrate the live repository, change the default selector, or run a real model.
```

## Session 4 — pre-migration audit only

```text
Prepare task repository-migration outside /swe, but perform read-only audit only. Do not apply migration, edit source, mutate workflow state, or commit.

Confirm cutover rehearsal passed. Inventory the real repository with the production migration audit. Explicitly exclude:
- .model-artifacts/initiatives/swe-production-rollout/workflow.json;
- every workflow with active/live ownership;
- any topic blocked by pi-artifacts ownership, unresolved recovery, malformed state, or ambiguous layout.

For every remaining topic, report classification, preimage hash, proposed disposition, exact action, rollback evidence path, and blocker. Previously complete workflows require an explicit proposed choice: reopen for fresh v2 acceptance, grandfather as read-only history, or block for review. Redact payloads and secrets. Save no source changes. Return a bounded authorization table for the user to approve topic-by-topic.
```

## Gate 1 — live repository migration authorization

The user must supply all fields below before Session 5. Feeding Session 5 with placeholders unchanged is not authorization.

```text
AUTHORIZED_BY: <human actor>
AUTHORIZED_AT: <ISO-8601 timestamp>
AUDIT_HASH: <hash of reviewed read-only audit>
TOPIC_DISPOSITIONS:
  <topic>: <reopen | grandfather-read-only | block>
ROLLBACK_RETENTION_UNTIL: <ISO-8601 timestamp>
RATIONALE: <human rationale>
```

## Session 5 — `repository-migration` apply

```text
Execute only task repository-migration from .model-artifacts/initiatives/swe-production-rollout/workflow.json, outside /swe, using this explicit operator decision:

<PASTE COMPLETED GATE 1 RECORD>

Refuse to proceed if any field is missing, the fresh audit hash differs, a preimage changed, any selected topic gained live ownership, recovery is unresolved, or swe-production-rollout appears in the target set. Do not edit application/extension source. Apply only explicitly selected topics through the implemented lock/CAS/atomic migration service. Persist bounded per-topic before/after hashes and recovery receipts. Retain rollback evidence and all legacy history.

After apply, run a fresh audit and require no unresolved supported-workflow migration among authorized targets. Run:
- npm run check:model-artifacts
- npm run test:swe
- git diff --check

Show the exact changed workflow/receipt/report files. Commit only authorized migration artifacts with `chore: migrate repository swe workflows` if checks pass. Do not push, publish, deploy, release, or modify the controlling rollout workflow.
```

## Session 6 — independent migration review

```text
Independently review the repository-migration commit outside /swe. Do not modify files or workflow state. Compare every migrated topic with its reviewed audit decision, preimage/postimage hashes, receipt, and rollback evidence. Prove the controlling swe-production-rollout workflow and all live-owned workflows are byte-identical. Prove completed historical work did not acquire fresh v2 acceptance. Rerun the post-migration audit, npm run check:model-artifacts, npm run test:swe, and git diff --check.

Return blockers or an explicit approval. Do not commit, push, activate, or release.
```

## Gate 2 — default-v2 cutover authorization

Session 7 is production activation. It requires a separate human decision after Sessions 1–6 pass.

```text
DECISION_ID: <unique id>
AUTHORIZED_BY: <human actor>
AUTHORIZED_AT: <ISO-8601 timestamp>
READINESS_EVIDENCE_HASH: <reviewed readiness report hash>
MIGRATION_EVIDENCE_HASH: <reviewed post-migration report hash>
TARGET_RUNTIME: v2
ROLLBACK_SELECTOR: compatibility
ROLLBACK_WINDOW_END: <ISO-8601 timestamp>
RATIONALE: <human rationale>
```

## Session 7 — `default-v2-runtime` and self-hosting handoff

```text
Implement and execute only task default-v2-runtime from .model-artifacts/initiatives/swe-production-rollout/workflow.json using this explicit operator decision:

<PASTE COMPLETED GATE 2 RECORD>

Refuse placeholders, stale evidence, active children, unresolved recovery, unsupported repository state, or ambiguous selector state. Stay inside the canonical task writeScope. Implement one shared runtime selection for entrypoint, command, tool, UI, and engine; no mixed managed execution. Preserve compatibility runtime for bounded rollback without rewriting evidence or transferring ownership.

Perform the canonical two-phase handoff only: reach a durable no-child checkpoint; persist the decision; reload atomically; reclaim the controlling workflow under fresh v2 parent authority; invalidate v1 leases and one-shot grants; resume from durable state. Rollback must use the symmetric fenced handoff. Do not manually edit workflow.json.

Run:
- node --experimental-strip-types --test test/pi-swe-cutover.test.ts test/pi-swe-runtime.test.ts test/pi-swe-command.test.ts test/pi-swe-tool.test.ts
- npm run typecheck
- git diff --check

Record selected runtime, decision identity, readiness evidence, rollback deadline, and handoff receipt. Commit task source/schema/tests and authorized selector evidence as `feat: make swe v2 runtime the default`. Do not push, publish, deploy, or remove v1 execution/read compatibility.
```

## Session 8 — post-cutover recovery and rollback review

```text
Independently validate the default-v2 cutover in a fresh session. Use the new runtime only after confirming it reports v2 and has reclaimed the controlling workflow with fresh parent authority. Do not patch first.

Test restart/resume, stale v1 leases, late child results, two concurrent parents, runtime reload, cancellation, protected verification, final acceptance gates, and the bounded compatibility rollback path. Verify no accepted evidence or migration receipt is rewritten. Run the default-v2 task checks plus npm run test:swe and git diff --check.

If any ownership, recovery, or rollback blocker exists, stop and recommend Gate 2 rollback; do not improvise. Otherwise return explicit approval and the observed rollback-window deadline. Do not commit or push.
```

## Gate 3 — rollback-window closure

Do not retire v1 execution merely because tests pass. The human operator must explicitly close the rollback window.

```text
DECISION_ID: <unique id>
AUTHORIZED_BY: <human actor>
AUTHORIZED_AT: <ISO-8601 timestamp>
CUTOVER_EVIDENCE_HASH: <approved post-cutover report>
ROLLBACK_WINDOW_ENDED: true
RATIONALE: <human rationale>
```

## Session 9 — `retire-v1-execution`

```text
Implement only task retire-v1-execution from .model-artifacts/initiatives/swe-production-rollout/workflow.json using this explicit rollback-window decision:

<PASTE COMPLETED GATE 3 RECORD>

Refuse missing/stale authorization. Stay within the canonical task writeScope. Remove or tombstone obsolete v1 start, verify, complete, single-parent, and rollback-start selectors. Retain v1 workflow/artifact readers and migration support through Gentic 1.0. Every retired path must return explicit migration/recovery guidance, never partial fallback. Remove stale command/tool/docs claims while preserving historical inspection.

Run:
- node --experimental-strip-types --test test/pi-swe.test.ts test/pi-swe-store.test.ts test/pi-swe-tool.test.ts test/pi-swe-command.test.ts
- npm run typecheck
- npm run test:swe
- git diff --check

If green, commit only task files as `refactor: retire swe v1 execution paths`. Do not push, delete history, remove v1 readers, publish, or release.
```

## Session 10 — `cutover-release-qualification`

```text
Implement only task cutover-release-qualification from .model-artifacts/initiatives/swe-production-rollout/workflow.json after an independent review approves v1 execution retirement. Stay within its canonical writeScope. Do not push, publish, deploy, release, delete rollback evidence, or remove v1 read compatibility.

Complete deterministic end-to-end qualification for default v2, migration, rollback boundary, start/resume UX, recovery, and final acceptance. Update operator docs, swe-orchestration skill, changelog/release docs, CI, catalogs, Pi contract, package/lock metadata, and release report so all surfaces agree. Explicitly classify semantic-version impact and breaking migration requirements.

Run release verification in a disposable clean checkout at the candidate commit; keep the control checkout's workflow.json authoritative. Import only the bounded report as evidence. A real-model smoke test is forbidden unless the user separately supplies credentials and explicit authorization; otherwise record an honest skip.

Run every canonical command:
- npm run test:swe
- npm test
- npm run check
- npm run check:commands
- npm run check:performance
- npm run typecheck
- git diff --check

Require all to pass. If green, commit only qualification files and bounded release evidence as `docs: qualify swe v2 production rollout`. Do not push or release.
```

## Session 11 — final adversarial review

```text
Perform a fresh independent final review of the complete descendant history from e882cd62deb541aa437c16c72781a1ccd243055e through the cutover-release-qualification commit. Do not modify files, workflow state, runtime selection, or Git history.

Review for concrete blockers in:
- lifecycle or final-acceptance bypasses;
- migration loss, active-controller targeting, and rollback corruption;
- concurrent parents, stale leases/grants, and late child results;
- retained workspace/evidence deletion;
- mixed v1/v2 execution or surviving retired selectors;
- start/resume and keyboard-accessible contextual UX;
- secret leakage, misleading sandbox claims, and unbounded output;
- package/catalog/command/resource/version drift.

Rerun the complete release command set in a clean disposable checkout. Compare release evidence hashes with the candidate commit. Return severity-ranked findings with exact evidence, or explicit approval. Do not commit, push, publish, deploy, or release.
```

If review finds blockers, use a fresh remediation session constrained to the owning task's write scope, rerun that task's checks, rerun Session 11, and create a separate remediation commit.

## Session 12 — final handoff, no external side effects

```text
Prepare the final swe-production-rollout handoff after Session 11 approval. Do not change source, workflow state, runtime selection, or Git history. Confirm:
- HEAD and clean-checkout release report hashes;
- v2 is the sole managed execution default;
- v1 readers/migration compatibility remain through Gentic 1.0;
- rollback-window closure evidence is retained;
- the full release command set passes;
- no workflow, todo, lease, recovery, or retained-workspace blocker remains;
- no push, publish, deployment, or release has occurred.

Produce a concise operator report with commit range, decisions, migration receipts, runtime selector state, compatibility boundary, verification results, known risks, and the exact next external action requiring separate user authorization. Do not perform that action.
```

## Completion condition

The work is ready only after Session 11 approves a clean candidate and Session 12 confirms the handoff. Readiness still does **not** authorize push, publication, deployment, release, or any other external side effect.

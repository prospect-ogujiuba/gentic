# Model-artifacts layout v2

Gentic writes durable initiative artifacts only beneath:

```text
.model-artifacts/initiatives/<topic>/{specs,plans,todo,findings,reports,logs}/
```

Non-initiative runtime, release, and migration records belong only beneath `.model-artifacts/system/logs/` or `.model-artifacts/system/reports/`. Generated Markdown uses `YYYY-MM-DD_HHMM-<short-name>.md`. The lightweight pi-swe `workflow.json` is stable authority directly beneath its initiative topic; former `manifest.json`, `contracts.json`, and contract files remain accepted as read-only migration history. Paths are project-relative POSIX paths with kebab-case topic segments. `docs/plans/` is curated human-facing documentation, never generated plan authority.

## Compatibility window

Gentic 0.x readers recognize a complete kind-first topic only for inspection and explicit migration. Writers emit v2 only. A v1-only topic returns migration-required guidance; the same topic in both layouts is a blocking conflict. Removing v1 read compatibility requires a separate reviewed release and will not occur before Gentic 1.0.

## Migration runbook

Run this sequence once per repository, from a clean scoped worktree and a released build containing the v2 migration engine:

```text
/artifacts audit
/artifacts plan
# review the saved JSON plan and its exact fingerprint
/artifacts apply .model-artifacts/system/logs/model-artifact-migration/<timestamp>-<id>-plan.json
/artifacts audit
npm run check:model-artifacts
npm run release:verify -- --report .model-artifacts/system/reports/release/<timestamp>-release-verification.md
```

Before apply:

1. Resolve every blocker, ambiguous mapping, mixed topic, active claim, collision, and stale fingerprint.
2. Record file, byte, reference, staging, rollback, and duration estimates from the plan report.
3. Review the old→new moves and rewrites, then approve the exact saved plan fingerprint. Regenerate rather than editing a plan.
4. Ensure enough storage for staging and rollback and retain the plan/report outside transient terminal output.

Apply revalidates the saved plan, source/reference fingerprints, destinations, bounds, and exclusive claim. Never manually move protected authority or delete `active.claim.json`. If interrupted, confirm the recorded process is gone and use `/artifacts recover <journal-path>`.

## Rollback retention and rehearsal

Apply retains the ledger and payload bundle under `.model-artifacts/system/logs/model-artifact-migration/`. Before release, rehearse restore on an equivalent disposable checkout or fixture:

1. Record the pre-apply tree fingerprint.
2. Apply the exact reviewed plan.
3. Run `/artifacts rollback <ledger-path>` without modifying v2 files.
4. Confirm byte-identical restoration and the original audit result.
5. Recreate/review/apply a fresh plan for the real migration.

If post-migration verification fails, stop release and use the retained ledger/bundle unless the failure is understood and an approved in-scope correction is safer. Rollback refuses modified v2 bytes. `/artifacts finalize <ledger-path>` irreversibly deletes payloads; do not finalize until the release retention decision explicitly accepts loss of rollback.

## pi-swe semantic migration

Artifact relocation and workflow semantic migration are separate, mutually exclusive transactions. Finish or recover `/artifacts` first, then operate pi-swe per topic:

1. `/swe migrate audit` — bounded, repository-wide, read-only classification.
2. Select one topic. Resolve malformed, unknown-version, mixed-layout, and unsupported cases without changing their authority bytes.
3. For incomplete work, `/swe migrate apply <topic>`. For completed work, use the keyboard-confirmed `reopen` or `grandfather-read-only` disposition; leaving it for operator review writes nothing.
4. Restart the operator session/process, run `/swe migrate audit`, and repeat the same selected apply to prove idempotency.
5. Run the SWE and repository checks before any production activation.

Apply binds the decision to source paths plus an exact preimage hash, uses the workflow mutation lock, and retains before/after hashes and recovery data under `.model-artifacts/system/logs/pi-swe-migration/`. `/swe migrate recover <topic>` reconciles an interrupted publish. `/swe migrate rollback <topic>` is keyboard-confirmed, refuses intervening edits, restores only the exact retained preimage, and preserves the receipt. Retention cleanup is a separate destructive decision and is not part of migration apply.

Historical completed tasks remain immutable and cannot count as fresh v2 review, verification, or final acceptance. `reopen` requires new v2 initiative acceptance; `grandfather-read-only` cannot be started, resumed, revised, verified, blocked, completed, or automatically advanced. All other v1 mutation attempts return the next legal migration action. Gentic retains v1 read and explicit-migration compatibility through the 1.0 boundary; removing those readers needs a separate reviewed release.

For multiple topics, select and apply each independently and preserve every result. A failure does not hide prior successes and is never converted into migrate-all behavior. Do not run pi-artifacts while a SWE semantic journal or applied recovery receipt exists, and do not run SWE apply while a pi-artifacts claim, journal, or transaction bundle exists.

## Remaining v1 references

`npm run check:model-artifacts` blocks non-v2 artifacts and unclassified kind-first strings. Allowed matches are bounded to migration compatibility code/docs, v1 reader code/docs, explicit test fixtures, retained transaction evidence, and historical initiative/runtime evidence. New runtime writers, public examples, workflows, and release paths must use v2.

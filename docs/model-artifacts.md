# Model-artifacts layout v2

Gentic writes durable initiative artifacts only beneath:

```text
.model-artifacts/initiatives/<topic>/{specs,plans,todo,findings,reports,logs}/
```

Non-initiative runtime, release, and migration records belong only beneath `.model-artifacts/system/logs/` or `.model-artifacts/system/reports/`. Generated Markdown uses `YYYY-MM-DD_HHMM-<short-name>.md`; canonical pi-swe contract filenames, `manifest.json`, and `contracts.json` are stable exceptions. Paths are project-relative POSIX paths with kebab-case topic segments. `docs/plans/` is curated human-facing documentation, never generated plan authority.

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

## Remaining v1 references

`npm run check:model-artifacts` blocks non-v2 artifacts and unclassified kind-first strings. Allowed matches are bounded to migration compatibility code/docs, v1 reader code/docs, explicit test fixtures, retained transaction evidence, and historical initiative/runtime evidence. New runtime writers, public examples, workflows, and release paths must use v2.

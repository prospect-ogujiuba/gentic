# pi-artifacts

`pi-artifacts` safely plans legacy `.model-artifacts` relocation into Gentic's canonical topic-first layout. It is deterministic code, not an LLM classification workflow.

## Anatomy

- **Mode:** `layered`
- **Public entry:** `index.ts`
- **Layers:** `domain`, `app`, `pi`
- **Command:** `/artifacts`
- **Runtime dependencies:** Node standard library only
- **Peers:** none required; it does not import `pi-swe` or `pi-todo` internals
- **Tests:** `node --experimental-strip-types --test test/pi-artifacts.test.ts`

`src/domain/` owns path normalization, bounded inventory, classification, canonical plan records, and fingerprints. `src/app/` owns plan persistence and transactional apply/rollback. `src/pi/commands.ts` is the thin Pi command adapter.

## Canonical destinations

Initiative and system artifacts use:

```text
.model-artifacts/initiatives/<topic>/<kind>/YYYY-MM-DD_HHMM-<short-name>.md
.model-artifacts/system/<logs|reports>/YYYY-MM-DD_HHMM-<short-name>.md
```

Initiative kinds are exactly `specs`, `plans`, `todo`, `findings`, `reports`, and `logs`. Canonical pi-swe contract filenames, `manifest.json`, and `contracts.json` remain stable exceptions. Topic segments and generated short names are kebab-case. `docs/plans/` is curated documentation only, never generated authority.

## Safe workflow

Run the workflow independently in each project:

```text
/artifacts audit
/artifacts plan
/artifacts apply .model-artifacts/system/logs/model-artifact-migration/<timestamp>-<id>-plan.json
/artifacts recover .model-artifacts/system/logs/model-artifact-migration/<timestamp>-<id>-apply-journal.json
/artifacts rollback .model-artifacts/system/logs/model-artifact-migration/<timestamp>-<id>-ledger.json
/artifacts finalize .model-artifacts/system/logs/model-artifact-migration/<timestamp>-<id>-ledger.json
```

- `audit` is read-only and reports canonical-valid, legacy-movable, protected, ambiguous, and invalid entries.
- `plan` is read-only with respect to candidates. It writes a reviewable JSON plan and bounded Markdown report under `.model-artifacts/system/logs/model-artifact-migration/`.
- A complete kind-first topic is one migration authority unit. The plan includes sorted old→new paths, exact reference rewrites, source and expected post-transform hashes, bounds, rollback storage, blockers, and a semantic fingerprint.
- `apply` revalidates the exact saved plan and fingerprints, stages original and transformed bytes on disk, validates the complete v2 graph, then publishes under an exclusive claim and append-only named-state journal.
- `recover` consumes a retained apply or rollback journal after an interruption. It deterministically restores preimages or completes rollback, writes durable recovery evidence, and is idempotent.
- `rollback` requires the exact terminal ledger and retained payload bundle written by apply. It refuses modified v2 bytes and restores byte-identical v1 files plus external rewrites.
- `finalize` is a separate irreversible action. It revalidates published v2 bytes, removes rollback payloads, and leaves a durable finalized ledger and report. It is never implicit.

Dry-run audit/plan is always the first step. Review and approve the exact saved-plan fingerprint before applying it; regenerate instead of editing a plan. For several projects, run audit in every project first, then apply one project at a time; transactions are deliberately not cross-repository. The operator checklist and rollback rehearsal are in [`../../docs/model-artifacts.md`](../../docs/model-artifacts.md).

## Deterministic inference

For isolated legacy Markdown, destination fields use this precedence:

1. exact project configuration mapping;
2. approved kind/topic evidence already present in the path;
3. exact `Topic:` metadata;
4. timestamp embedded in the filename;
5. Git first-add timestamp when available.

Missing or contradictory evidence remains `ambiguous`. Filesystem mtime and semantic/AI guesses are never used.

## Explicit mappings

Optional `.pi/model-artifacts-migration.json`:

```json
{
  "schemaVersion": 1,
  "mappings": {
    ".model-artifacts/reports/report.md": {
      "kind": "reports",
      "topic": "my-feature",
      "timestamp": "2026-08-31_1430",
      "shortName": "migration-report"
    }
  }
}
```

The schema is closed. Sources must be exact project-relative `.model-artifacts/...` paths. Unsupported kinds, unknown keys, absolute/traversing paths, invalid timestamps, and invalid topic segments are rejected.

## Protected authority and conservative blockers

Planning never mutates candidates. It blocks:

- mixed kind-first/topic-first authority for one topic;
- incomplete, unsupported, stale, ambiguous, or cross-topic authority;
- collisions, unsafe paths, symlinks, and bound violations;
- active migration claims or records that require recovery;
- isolated legacy candidates with inbound textual references.

Protected canonical v1 files become migratable only when the manifest, active spec/plan, contract index, indexed contracts, and recorded verification/review paths form one complete, hash-valid authority unit. Exact reference and structured content-hash rewrites are planned in dependency order; cycles block.

## Transaction and recovery

Preflight is mutation-free. Apply revalidates eligibility, plan/config fingerprints, normalized paths, source and external-reference bytes, destination absence, bounds, and claim state before creating transaction artifacts. Original and transformed bytes are retained beneath the system migration log; every staged hash and schema-v2 manifest is checked before any destination is published. Exact repeats return `already-applied`.

Rollback validates the ledger against the saved plan and every current v2 fingerprint, restores records in reverse order without overwrite, and records `rolled-back`. Exact repeats return `already-rolled-back`. Any modified v2 byte blocks rollback.

Claims are never auto-reaped. If a crash or injected fault leaves `active.claim.json` and a journal:

1. confirm the recorded owner process is no longer running;
2. inspect and preserve the retained journal, ledger (if present), payload bundle, and hashes;
3. run `/artifacts recover <journal-path>`; do not remove the claim manually;
4. recovery verifies claim identity and current bytes, restores the exact recorded preimages or completes the recorded rollback, and writes durable recovery evidence;
5. repeat the same recovery command safely if operator confirmation was interrupted;
6. rerun audit and create a new plan when state changed.

Conflicting or changed bytes block recovery rather than being overwritten. After post-migration verification, `/artifacts finalize <ledger-path>` permanently deletes rollback payloads and records that rollback is unavailable.

## Bounds and compatibility

Gentic 0.x keeps kind-first reads only for audit and explicit migration. Writers are v2-only, mixed topics block, and removing v1 read compatibility is a separate reviewed change no earlier than 1.0.

- Maximum inventory: 10,000 artifact entries; maximum aggregate candidate bytes: 64 MiB.
- Reference scanning defaults to 20,000 files and 256 MiB, skips common dependency/build directories, and ignores individual files above 1 MiB.
- Planning separately bounds affected bytes, references, rewrite records, and rollback bytes; reports include counts and storage estimates.
- Non-Markdown legacy files are inventoried but not migrated.
- No model-callable mutation tool or custom TUI is registered.

# pi-artifacts

`pi-artifacts` safely organizes legacy `.model-artifacts` files into Gentic's canonical kind/topic/timestamp layout. It is deterministic code, not an LLM classification workflow.

## Anatomy

- **Mode:** `layered`
- **Public entry:** `index.ts`
- **Layers:** `domain`, `app`, `pi`
- **Command:** `/artifacts`
- **Runtime dependencies:** Node standard library only
- **Peers:** none required; it does not import `pi-swe` or `pi-todo` internals
- **Tests:** `node --experimental-strip-types --test test/pi-artifacts.test.ts`

`src/domain/` owns path normalization, bounded inventory, classification, canonical plan records, and fingerprints. `src/app/` owns plan persistence and transactional apply/rollback. `src/pi/commands.ts` is the thin Pi command adapter.

## Canonical destination

Migrated Markdown files use:

```text
.model-artifacts/<kind>/<topic>/YYYY-MM-DD_HHMM-<short-name>.md
```

Approved kinds are `reports`, `plans`, `findings`, `logs`, `specs`, and `todo`. Topic segments and short names are kebab-case.

## Safe workflow

Run the workflow independently in each project:

```text
/artifacts audit
/artifacts plan
/artifacts apply .model-artifacts/logs/model-artifact-migration/<timestamp>-<id>-plan.json
/artifacts rollback .model-artifacts/logs/model-artifact-migration/<timestamp>-<id>-ledger.json
```

- `audit` is read-only and reports canonical-valid, legacy-movable, protected, ambiguous, and invalid entries.
- `plan` is read-only with respect to candidates. It writes a reviewable JSON plan and bounded Markdown report under `.model-artifacts/logs/model-artifact-migration/`.
- `apply` is the only migration action. It requires an exact eligible saved plan.
- `rollback` requires the exact terminal ledger written by apply.

Dry-run audit/plan is always the first step. Review the plan before applying it. For several projects, run audit in every project first, then apply one project at a time; transactions are deliberately not cross-repository.

## Deterministic inference

Destination fields use this precedence:

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

The extension never automatically moves or rewrites:

- canonical manifests;
- active specs, plans, contract roots, indexed contracts, completion verification, or implementation reviews reachable from canonical state;
- migration plans, journals, claims, and ledgers;
- symlinks or paths outside the selected project;
- legacy candidates with inbound textual references.

Automatic reference rewriting, canonical content-hash regeneration, deletion, and deduplication are intentionally omitted. Resolve references manually or update explicit mappings, then generate a new plan.

## Transaction and recovery

Apply revalidates the plan fingerprint, root, normalized config, source hashes, destination absence, and owner-token claim. It writes one move at a time through a durable staged journal, exclusive destination creation, byte/hash verification, source removal, and a terminal ledger. Exact repeats return `already-applied`.

Rollback validates the ledger against the saved plan, verifies destination bytes, restores in reverse order without overwrite, and records `rolled-back`. Exact repeats return `already-rolled-back`.

Claims are never auto-reaped. If a crash or injected fault leaves `active.claim.json` and a journal:

1. confirm the recorded owner process is no longer running;
2. inspect the retained journal, sources, destinations, and hashes;
3. preserve/copy the journal as recovery evidence;
4. restore or complete the recorded move without guessing;
5. remove the claim only after ownership and bytes are reconciled;
6. rerun audit and create a new plan when state changed.

Conflicting or changed bytes block recovery rather than being overwritten.

## Bounds and compatibility

- Maximum inventory: 10,000 artifact entries.
- Maximum aggregate candidate bytes: 64 MiB.
- Text reference scanning skips common dependency/build directories and files above 1 MiB.
- Non-Markdown legacy files are inventoried but not migrated.
- No model-callable mutation tool or custom TUI is registered.

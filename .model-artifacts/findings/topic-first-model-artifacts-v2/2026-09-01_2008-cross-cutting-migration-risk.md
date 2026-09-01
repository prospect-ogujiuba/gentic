# Cross-Cutting Finding: Security, Migration, Performance, Operations, Compatibility

- Topic: `topic-first-model-artifacts-v2`
- Reviewed spec: `.model-artifacts/specs/topic-first-model-artifacts-v2/2026-09-01_2008-initiative-spec-r1.md`
- Reviewed plan: `.model-artifacts/plans/topic-first-model-artifacts-v2/2026-09-01_2008-plan-index-r1.md`
- Decision: accept direction with blocking requirements for plan revision

## Security

- Normalize and validate every source/destination/reference as a project-relative POSIX path; reject absolute paths, `..`, backslashes, NUL/control bytes, case-fold collisions where relevant, symlink roots/entries, and realpath escapes.
- Preserve fail-closed bounds before reading/copying. Use exclusive creation and non-following file operations where the platform permits.
- Plans and ledgers are untrusted repository files: closed schemas, exact keys/types, fingerprints, and destination/source revalidation are required at load and again at preflight.
- Never overwrite existing destinations or rollback over modified v2 bytes. Error messages must not print artifact contents.

## Migration

- Migration unit is a complete topic authority, not an individual canonical file. Isolated legacy Markdown remains a separate explicit mapping case.
- Define structured rewrite order: artifact leaves, contract files, `contracts.json`, plan index/pointers, manifest, external exact references. Recompute and verify hashes before publication.
- A topic found in both layouts is a blocker. A v1 reader never silently prefers v2, and a v2 writer never creates a parallel topic beside v1.
- Transaction records move to `.model-artifacts/system/logs/model-artifact-migration/`; the active claim has one stable v2 location. Legacy active claims must be resolved before the v2 migration begins.
- Retain rollback payloads and add explicit finalize. Recovery and rollback semantics must be documented for power loss at each state.

## Performance

- Preserve max files/bytes and add max affected bytes, staging bytes, rollback bytes, references, and rewrite records.
- Use one bounded repository reference scan with an indexed path matcher, deterministic arrays/maps, streaming copy/hash where practical, and disk-backed payloads.
- Emit counts/bytes/duration in bounded reports. Benchmark or at least measure Gentic audit/plan/apply before DevArch; no specialized data structure without evidence.

## Operations

- Commands must expose audit summary, plan path/fingerprint, blockers, storage estimate, claim owner/state, recovery action, rollback eligibility, and finalize consequences.
- Apply requires an exact saved plan and explicit operator action. Finalize requires a separate explicit action and states that rollback payload deletion is irreversible.
- A dirty or changing target tree must fail preflight unless changes are outside enumerated sources/references and policy explicitly permits them.
- Gentic self-migration and DevArch migration each require pre/post audit and repository verification evidence. DevArch additionally requires repository-owner approval of the exact fingerprint.

## Compatibility

- Advance pi-swe manifest schema to v2; v1 parsing is read-only and produces migration guidance. Do not overload schema v1 with new path semantics.
- Inventory every Gentic-owned hard-coded path, including pi-context/runtime lifecycle, root scripts, resource validation, READMEs, skills, examples/e2e scenarios, and tests—not only the four initially named components.
- Keep v1 read support for a declared deprecation window; removal is a separate initiative. Remaining v1 strings must be tagged by test/compatibility purpose so a repository scan can distinguish them.
- `docs/plans/` is curated documentation only and must not be machine authority or a canonical-plan mirror.

## Required incorporation

1. Add explicit local-adapter conformance rather than a new cross-extension runtime dependency.
2. Add the structured hash dependency DAG and disk-backed rollback representation.
3. Add plan/transaction bounds and operational summaries.
4. Add mixed-topic, active-legacy-claim, dirty/stale tree, and modified-rollback blockers.
5. Add explicit finalize and deprecation-window documentation.
6. Expand affected-file inventory to all Gentic consumers found by repository scan.

# implementation-brief

Created: 2026-09-03T18:35:21.610Z
Purpose: Provide Gentic with a concrete implementation prompt for fixing pi-swe schema compatibility and completion ergonomics

# Pi-SWE Backward-Compatible Completion Rework

## Problem statement

Pi-SWE currently turns harmless metadata drift into a repeated manual plan/review/completion loop. A valid P1.1 implementation had current passing verification and an approved implementation review, yet guarded completion failed serially on unrelated orchestration metadata.

Observed sequence in `/home/priz/projects/csr-email`:

1. `/swe complete ... approve advance` rejected because `manifest.approval.decision` was `"approve"`, while completion required `"approved"`.
2. After normalizing that token, the identical completion request rejected because the schema-v1 `contracts.json` used `dependencies`; current code reads required `dependsOn` and reported `contract dependencies must be a bounded string array`.
3. The same legacy schema-v1 entries also use `canonicalPath`, omit subphase `parentId`, and use `approved_not_started` / `awaiting_dependency` instead of `pending` / `in_progress` / `blocked` / `complete`.
4. Code-path inspection found further incompatibilities: the current graph accepts only `NN` / `NN.NN` IDs, while the approved plan, active contract, contract files, verification envelope, and implementation-review envelope consistently use `P1` / `P1.1`; readiness expects core specialist ID `accessibility-ux`, while the older writer emitted `accessibilityUx`.
5. Phase records participate in graph readiness and completion even though plans use them as grouping/exit nodes. Once facts are supplied, a phase can be selected before its child; when facts are omitted, phase blockers prevent a clean final lifecycle. Phase semantics are underspecified.
6. Completion surfaces only the first schema error. The second failure still suggested the manifest as the recovery artifact even though `contracts.json` was at fault. This encourages iterative hand-editing of canonical state.

Both rejected attempts were safely non-mutating: no journal was created and P1.1 remained active/in-progress. Preserve that transactional safety.

Key artifacts:

- `.model-artifacts/findings/outlook-data-file-operations-analysis/2026-09-03_1658-completion-blocker.md`
- `.model-artifacts/findings/outlook-data-file-operations-analysis/2026-09-03_1814-contract-index-completion-blocker.md`
- `.model-artifacts/reports/outlook-data-file-operations-analysis/2026-09-03_1654-verification.md`
- `.model-artifacts/reports/outlook-data-file-operations-analysis/2026-09-03_1654-implementation-review.md`
- `.model-artifacts/reports/outlook-data-file-operations-analysis/2026-09-03_1829-contract-index-schema-reconciliation.md`

## Root causes

- Breaking contract-index shapes reused `schemaVersion: 1`; there is no explicit migration boundary.
- Writers and readers disagree on state vocabulary (`approve` action versus `approved` state).
- Contract identity is coupled to one formatting convention despite explicit `kind` and `parentId` fields.
- Readiness mixes durable contract definitions, dynamic dependency state, and manually persisted availability facts.
- Phase grouping and executable contract state share one lifecycle without clear derivation rules.
- Completion validates raw persisted shapes instead of first loading a backward-compatible normalized model.

## Required implementation

1. **Introduce a versioned normalization/migration layer.**
   - Parse known legacy schema-v1 manifest/index variants into one current in-memory model.
   - Recognize `dependencies`/`canonicalPath`, legacy statuses, per-entry `readiness`/`consequentialSpecialistIds`, missing `parentId` when derivable, and `accessibilityUx`.
   - If the persisted current format is breaking, bump its schema version. Do not assign incompatible formats the same version again.
   - Provide deterministic serialization and an explicit migration record. Migration must preserve contract IDs, paths, content hashes, dependencies, active contract, approval identity, and evidence identity.

2. **Unify approval semantics.**
   - Treat review decision `approve` and manifest state `approved` as distinct named concepts in types.
   - Make all writers/readers consistent.
   - Accept the legacy manifest token `approve` and normalize it to approved state without requiring a new user approval.

3. **Make contract IDs backward-compatible and effectively opaque.**
   - Stop requiring only `NN` / `NN.NN` when `kind` and `parentId` already express structure.
   - At minimum accept both `P1` / `P1.1` and `01` / `01.01` families.
   - Never require renaming an already-approved contract, because that invalidates active pointers and cryptographically bound verification/review evidence.
   - Keep deterministic natural ordering independent of one ID grammar.

4. **Define phase semantics explicitly.**
   - Prefer phases as non-executable grouping/derived-state nodes.
   - Do not include a phase in `readyIds` or select it as `activeContract` ahead of a ready child.
   - Derive phase completion from child completion/exit rules, and use that derived state for dependencies and finalization; alternatively add an explicit executable flag and migrate old phase nodes deterministically.
   - `advance` after P1.1 must select P1.2, not P1.

5. **Separate durable readiness facts from dependency state.**
   - Dependency satisfaction must be computed from the graph, not persisted as a stale `entryInputsAvailable` value.
   - Preserve genuinely external missing inputs/capabilities as explicit blockers.
   - A legacy `awaiting_dependency` contract should become pending-with-dependency, not an explicitly blocked contract.
   - Completion should recompute next readiness atomically after marking the target complete.

6. **Make guarded completion one coherent operation.**
   - Inspect and normalize compatible legacy metadata before mutation.
   - Dry-run all validation and return all actionable diagnostics grouped by correct artifact/field, not only the first failure.
   - When migration is lossless and evidence remains bound to the same contract identity, atomically migrate + complete + record evidence + advance under the existing journal/rollback protocol.
   - Metadata-only normalization must not force plan revision, specialist rerun, verification rerun, implementation re-review, or new user approval.
   - Ambiguous/lossy migration must reject before mutation with one precise handoff.

7. **Improve diagnostics.**
   - Name the actual failing artifact (`contracts.json` versus `manifest.json`).
   - Report every incompatible field/status/ID in one bounded response.
   - Distinguish migration-required, evidence-stale, graph-invalid, and execution-blocked outcomes.

## Regression acceptance tests

Add an integration fixture matching the CSR-email legacy artifacts and prove:

1. A schema-v1 manifest with `approval.decision: "approve"`, specialist key `accessibilityUx`, and a schema-v1 index using `dependencies`, `canonicalPath`, legacy statuses, per-contract readiness, and `P1` / `P1.1` IDs is inspected successfully through normalization.
2. With valid existing P1.1 verification/review envelopes, one guarded `complete + advance` call atomically:
   - preserves plan/spec/contract content hashes and evidence identities;
   - marks P1.1 complete;
   - creates the canonical completion record;
   - advances `activeContract` to P1.2;
   - leaves no pending transaction journal;
   - does not request replan, reapproval, reverification, or rereview.
3. Phase P1 never preempts P1.2 in readiness selection; phase completion/finalization follows the documented derived lifecycle.
4. Retrying the identical request returns idempotent `already-complete` with the same completion identity.
5. A malformed or ambiguous legacy index reports all relevant fields with the correct artifact and performs zero mutation.
6. Fault injection at every journal stage retains existing rollback/recovery guarantees.
7. Both newly generated current artifacts and all supported legacy fixtures pass inspector, readiness, completion, and recovery tests.
8. New writers emit only the canonical current schema/version and vocabulary.

## Non-goals

- Do not weaken evidence hash binding or completion guards.
- Do not silently reinterpret genuinely conflicting dependencies or blockers.
- Do not rewrite immutable plan/spec/contract markdown during a lossless metadata migration.
- Do not force users to rename valid existing contracts merely to satisfy presentation-oriented ID formatting.

## Desired outcome

Existing approved work survives orchestration schema upgrades. A user with valid implementation and evidence runs completion once; pi-swe either completes atomically or returns one comprehensive, correctly attributed, genuinely actionable error—not a chain of metadata whack-a-mole.

# Cross-Cutting Finding: Completion Tool Safety, Operations, and Compatibility

- Specialists: security, operations, compatibility
- Status: complete
- Assessed topic: `swe-completion-tool`
- Spec: revision 1 — `.model-artifacts/initiatives/swe-completion-tool/specs/2026-09-04_1627-initiative-spec-r1.md` — `sha256:16d95aab053b42030f4f3be6955409a971caa698f1c466ae714ba8977d33b299`
- Draft plan: revision 1 — `.model-artifacts/initiatives/swe-completion-tool/plans/2026-09-04_1627-plan-index-r1.md` — `sha256:c4f5d1ef8fee2c6b64c7d6f4bc7dd79c5eefa6a2bedcf19dd4f9c0d975b63b9a`
- Created: 2026-09-04T16:27:32Z

## Security findings

- Treat report contents and paths as untrusted. Reuse one closed-envelope parser for both derivation and final transaction validation so acceptance rules cannot drift.
- Enumerate only direct regular-file children of `.model-artifacts/initiatives/<topic>/reports/`, sorted deterministically. Do not follow symlinks. Reject scan/read incompleteness rather than treating it as no match.
- Apply explicit limits before reading candidate bodies: at most 200 directory entries, at most 2 MiB per file, and at most 16 MiB aggregate bytes. Bounds failures are distinguishable from missing evidence.
- Match review candidates on the exact current topic, active contract ID/path, active plan revision, recomputed contract content hash, `decision: approve`, and zero blockers. Exactly one matching review envelope is required. Never resolve duplicates by mtime, filename, or validity of the downstream verification.
- Recompute the unique review hash from bytes; accept only its same-topic safe verification path and declared hash. Recompute verification bytes/hash and validate pass/gaps-none plus the same exact contract identity.
- `confirm` remains caller-controlled and required. Refuse before any scan or mutation when it is not exactly `true`.
- Keep the exclusive per-topic claim and all state reinspection inside `completeCanonicalContract`; derivation is not a lock and must not be treated as one.

## Operations findings

- A race between derivation and mutation is safe only because the full derived identity is passed to the unchanged transaction, which reacquires canonical state and rejects drift. Document and test this boundary.
- Resolver failures must be typed/structured enough for the tool to report `rejected`, an exact artifact or report scope, and one bounded remediation without throwing as an internal failure.
- Transaction `completed`, `already-complete`, `conflict`, `blocked-recovery`, and `rejected` results pass through unchanged semantically. Do not translate conflict into retry/success.
- Parallel `swe_complete` calls rely on the current claim: one winner, other conflict. No new file-mutation queue is needed because the transaction already serializes by topic and validates ownership; adding an outer queue would create a second concurrency authority.
- Recovery and lock cleanup remain manual/current behavior. The tool does not auto-reap or hide recovery artifacts.

## Compatibility findings

- Keep `CompleteCanonicalContractRequest`, `completeCanonicalContract`, `/swe complete`, and its usage/argument parser unchanged. The new adapter only constructs that public request.
- Register `swe_complete` additively from a focused `src/pi/tools.ts` adapter, wired by `index.ts`; use Pi `Type` plus `StringEnum(["clear", "advance"])` or the repository's equivalent Google-compatible enum.
- Public schema: optional `topic`, optional `contractId`, required `confirm`, optional `next`. Runtime defaults `next` to `advance`.
- Update extension mocks/test doubles that load `piSwe`, the README orientation statement that explicitly denies a model-callable tool, docs/e2e inventory, and any generated catalog/inventory only when repository checks require regeneration.
- Tool results should expose concise text plus structured details; do not include report bodies. Low-level command formatting may be reused for transaction results if it preserves tool-specific selection failures.
- Avoid a new legacy command alias, autonomous lifecycle step, or dependency on pi-todo/chat state. Omitted topic resolution uses canonical repository resolution only and fails when more than one active topic exists.

## Required plan revisions

- Split implementation into a non-mutating derivation contract followed by tool registration/integration.
- Specify the exact scan bounds and duplicate-candidate rule in P01-C01.
- Specify the derivation-to-transaction race guarantee and concurrency regression in P01-C01/P02-C01.
- Add the exact Pi tool schema, adapter location, test-double/docs updates, and retained low-level interface to P02-C01.

## Residual risk

A repository may intentionally retain multiple approving reviews for the same unchanged contract identity. This tool will reject until that ambiguity is resolved. The fail-closed behavior is intentional and non-blocking for implementation.

# Initiative Spec: SWE Completion Tool

- Topic: `swe-completion-tool`
- Revision: 1
- Created: 2026-09-04T16:27:32Z
- Predecessor: none
- State: planning

## Problem

Pi-SWE's guarded completion transaction already derives and validates canonical state, evidence identity, hashes, readiness, concurrency ownership, recovery, and advancement. Its only caller-facing mutation surface is `/swe complete`, which requires callers to copy the active plan revision, contract path/hash, verification path/hash, review path/hash, and approval token even though canonical artifacts already contain or bind those facts. This creates avoidable LLM/user transcription work and stale-input failures without adding a distinct security property.

## Outcome and observable behavior

Pi-SWE exposes one LLM-callable `swe_complete` tool with this public input shape:

```json
{
  "topic": "swe-completion-tool",
  "contractId": "P01-C01",
  "confirm": true,
  "next": "advance"
}
```

`topic`, `contractId`, and `next` are optional. `confirm` is required and must be `true`. The tool:

1. Resolves an explicit topic, or exactly one active canonical initiative when omitted; ambiguity rejects without mutation.
2. Resolves an explicit contract ID, or the selected manifest's active contract when omitted, and requires it to be the active indexed executable contract.
3. Derives the active plan revision and stable contract path from the exact inspected manifest/index snapshot.
4. Recomputes the contract file hash and requires it to equal the indexed content hash.
5. Finds exactly one approving implementation-review envelope under the selected topic's canonical `reports/` directory that binds the current topic, contract ID/path/hash, and plan revision.
6. Recomputes that review file's hash, follows its exact verification path/hash, recomputes the verification file hash, and validates the passing, gap-free verification envelope against the same contract identity.
7. Rejects before mutation when selection or evidence is absent, stale, unsafe, malformed, out of bounds, or ambiguous.
8. Constructs the existing full `CompleteCanonicalContractRequest` and calls `completeCanonicalContract` unchanged, preserving its journal, ownership, idempotency, migration, rollback, and readiness behavior.
9. Returns a compact structured result that reports completion status, selected identity, next active/ready contracts, and an actionable rejecting artifact/reason.

The existing long `/swe complete` command remains available as the explicit low-level/manual interface.

## Users

- Coding agents completing one reviewed canonical pi-swe contract.
- Maintainers using the long command for manual recovery, exact replay, and diagnostics.

## Constraints

- The existing guarded completion transaction and its request type remain the authoritative mutation boundary; the tool is a derivation adapter, not a second mutation implementation.
- No completion guard, evidence requirement, exclusive ownership rule, schema normalization rule, or recovery behavior is weakened.
- Tool registration follows Pi's `registerTool` contract and uses a Google-compatible enum schema.
- `confirm` cannot default to true or be derived from state.
- Evidence discovery is deterministic, direct-child only, sorted, non-symlink-following, and bounded by entry count, individual file size, and aggregate bytes.
- Candidate review selection is based on a closed, exactly-one-line `Pi-SWE-Evidence` envelope. More than one review envelope matching the current contract identity is ambiguous, even if only one referenced verification file currently validates; the caller must remove or supersede ambiguity explicitly.
- The review's verification path must remain under the same canonical topic's `reports/` directory. Path traversal, absolute paths, backslashes, symlink traversal, missing files, oversize files, and hash drift fail closed.
- Omitted topic resolution must not silently prefer chat state, todo state, lexical order, or a completed/blocked initiative when canonical resolution is ambiguous.
- Omitted contract resolution requires one manifest `activeContract`; the tool does not select an arbitrary ready contract.
- Tool output is bounded and does not emit report bodies.
- No production implementation occurs during planning.

## Non-goals

- Replacing, shortening, or changing `/swe complete` syntax.
- Changing evidence envelope schema, contracts schema, manifest schema, or completion record identity.
- Automatically generating verification or review evidence.
- Choosing the newest/oldest review when multiple current approving reviews exist.
- Auto-reaping completion locks, recovering corrupt journals, or bypassing explicit confirmation.
- Adding a generic evidence search/index service or an autonomous lifecycle runner.

## Compatibility

- Existing command callers and direct `completeCanonicalContract` callers remain source- and behavior-compatible.
- The new tool is additive and named `swe_complete`; no legacy command namespace is introduced.
- Existing supported schema-v1 canonical metadata remains normalized only by the unchanged transaction.
- Existing test doubles that instantiate the extension must implement or deliberately stub `registerTool`.
- README and end-to-end documentation must distinguish the concise LLM tool from the low-level command while documenting identical safety checks.

## Migration and rollback

No persisted data migration is introduced. Rollback is removal of the tool registration/resolver adapter and related documentation/tests. Because mutation still flows through `completeCanonicalContract`, durable completion rollback and crash recovery remain governed by the existing journal protocol.

## Risks

- An imprecise evidence scan could select an unrelated, historical, duplicated, or stale review.
- Optional topic/contract fields could hide ambiguity if resolution applies implicit preference.
- Refactoring private envelope parsing for reuse could accidentally change strict validation accepted by the low-level transaction.
- Tool registration could break extension tests or inventory documentation that currently assert no model-callable pi-swe tool.
- Parallel tool calls could race; the unchanged exclusive per-topic completion claim must remain the final authority.

## Acceptance criteria

- **AC1:** `swe_complete` is registered with optional `topic`, optional `contractId`, required boolean `confirm`, and optional `next` (`clear|advance`, default `advance`); `confirm !== true` rejects before evidence discovery or writes.
- **AC2:** Explicit and omitted topic/contract resolution is deterministic: only one canonical active initiative and one manifest active contract may be inferred; missing or ambiguous selection returns a bounded actionable rejection.
- **AC3:** The adapter derives the plan revision, contract path, and current contract hash from canonical state/files and rejects mismatches before calling the transaction.
- **AC4:** Exactly one current approving implementation-review envelope is required; zero or multiple matching reviews reject without mutation and identify the reports scope.
- **AC5:** The adapter calculates review and verification hashes, follows only the review-bound verification reference, validates exact passing/gap-free identity, and rejects missing, malformed, unsafe, stale, oversized, symlinked, or mismatched evidence.
- **AC6:** On valid evidence, the adapter calls the existing `completeCanonicalContract` with the fully derived request and preserves completed, already-complete, clear, advance, conflict, recovery, and idempotency semantics.
- **AC7:** The long `/swe complete` command and direct completion API remain unchanged and existing completion/fault-injection tests continue to pass.
- **AC8:** Focused tests cover confirmation refusal, explicit and inferred selection, missing/ambiguous/stale evidence, unrelated envelopes, path/symlink/bounds failures, valid complete/advance, clear, exact replay, and concurrent calls; package checks, typecheck, and the full suite pass.
- **AC9:** Pi-SWE README/end-to-end documentation lists `swe_complete`, its concise input, inference constraints, fail-closed behavior, and the retained low-level command.

## Open blockers

None for planning. Implementation requires exact plan approval and must begin with behavior-first failing tests; plan-time review does not claim Red evidence.

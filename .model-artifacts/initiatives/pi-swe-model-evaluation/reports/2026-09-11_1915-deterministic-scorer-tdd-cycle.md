# deterministic-scorer-tdd-cycle

Created: 2026-09-11T19:15:58.980Z
Purpose: Record runtime Red, Green, Refactor, and verification evidence for P03-C01.

# TDD cycle: deterministic lifecycle scorer

## Behavior: clean deterministic lifecycle scoring

- Test level: unit.
- Red evidence: `node --experimental-strip-types --test --test-name-pattern='deterministic scorer|deterministic score serialization' test/pi-swe-model-eval.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `src/score.ts` before production code existed.
- Green evidence: added `score.ts` and `canonical-diff.ts`; the focused command passed.
- Refactor evidence: corrected failed-tool exit-code handling and made the reordered-completion fixture exercise an actual order swap; focused command passed.
- Verification: focused scorer tests, full `pi-swe-model-eval.test.ts`, and `npm run typecheck` passed.
- Follow-up: none.

## Behavior: deterministic violation and retry classification

- Test level: table-driven unit.
- Red evidence: the same initial focused run failed before scorer implementation.
- Green evidence: clean, reordered, prose-only, fabricated-evidence, repeated-completion, forbidden-mutation, dependency-bypass, provider-retry, incomplete-finalization, and byte-identical serialization cases passed.
- Refactor evidence: evidence envelope hashes are validated against snapshot bytes and findings are serialized in stable order; focused command passed.
- Verification: focused scorer tests, full evaluator test file, and TypeScript typecheck passed.
- Follow-up: scenario-matrix integration remains P03-C02 scope.

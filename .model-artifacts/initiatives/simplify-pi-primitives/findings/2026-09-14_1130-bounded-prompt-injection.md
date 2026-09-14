# T3 bounded prompt injection

## Scope

Shared statically imported policy application replaces duplicated append logic. Conditional trigger sources and bundled policy wording are unchanged. Dynamic loader removal and whimsical changes remain T5 and T4 respectively.

## Security boundaries

Only bundled injection markdown is appended, never trigger content. Conditional matching ignores existing system text and retains prompt/customPrompt/appendSystemPrompt/contextFiles activation. All policies deduplicate by heading and reject resources above 8192 UTF-16 code units during registration. A forged heading can suppress optional guidance; these policies are not authorization or security enforcement.

Structured trigger data is capped at 32768 code units, 1024 visited values, and depth 16. Overflow, cycles, accessors and traversal errors fail closed. Getters are not executed. JavaScript proxies and arbitrary executable trigger regex configuration are not a sandboxed input contract: regexes remain trusted package resources. No secret collection, external calls, or tool authorization changes were introduced.

## Reproduction and same-input measurement

Before production changes, new tests failed on unbounded flattening and duplicate conditional injection. Existing baseline tests remained the characterization of activation semantics.

Measured `flattenTriggerText(Array(10000).fill("x".repeat(1000))).length` with the same Node command before and after:

- Before: 10009999 characters materialized.
- After: 0 characters returned (fail closed); accumulation stops before exceeding 32768 characters.

This is an allocation/output-size measurement, not a wall-clock performance claim. Large data already supplied by the caller is not reclaimed by the scanner.

## Verification

Primitive tests cover exact policy/character/node boundaries, deep/cyclic/accessor inputs, preserved structured context and prompt-option activation, unrelated-input exclusion, idempotence, no trigger-content interpolation, and startup failure isolation. Run `npm run test:primitives` and `npm run typecheck` for the final objective checks.

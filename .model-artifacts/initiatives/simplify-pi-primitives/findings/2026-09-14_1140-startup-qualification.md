# T5 startup qualification

Removed unused `loadPrimitive`/`loadPrimitives` discovery and cache-busted imports. Explicit registration remains the only startup path. Migrated failure/config tests to explicit definitions; retained synchronous failure diagnostics and added asynchronous rejection, malformed config, global disablement, and removal-contract coverage.

## Baseline comparison

Same source measurement on `extensions/pi-primitives/index.ts`, before and after T5:

| Metric | Before | After |
| --- | ---: | ---: |
| UTF-8 bytes | 6140 | 4422 |
| Directory scan call sites | 1 | 0 |
| Dynamic import call sites | 1 | 0 |

T2 already switched normal startup to explicit registration. T5 removes the unused alternate path; these numbers measure removed code and discovery capability, not a claimed wall-clock startup speedup. Startup regression tests exercise production registration with all four definitions, config disablement, and isolated failure reporting. No live TUI smoke test was performed.

## Operations

README documents coherent-package upgrade/rollback, idle-session restart, named failure diagnostics, disabling broken initializers, malformed-config fallback, and static-import failure limitations. Registration is not transactional; partially installed custom hooks require a restart after repair. The removed helper was an internal export; local consumers must move to explicit definitions. Do not deploy a parallel legacy loader.

## Verification

The new removal-contract test failed before deleting the loader. Final planned checks: `npm run test:primitives`, `npm run typecheck`, and `npm run check`, each recorded in workflow evidence after its protected bash result.

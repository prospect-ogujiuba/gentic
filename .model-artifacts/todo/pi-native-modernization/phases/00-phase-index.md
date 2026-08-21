# Pi-native modernization phase index

Created: 2026-08-21
Purpose: Provide an editable implementation order for bringing Gentic into durable alignment with Pi 0.84.2 and later releases.

## Review order

1. [01-baseline-and-compatibility.md](01-baseline-and-compatibility.md)
2. [02-package-and-resource-normalization.md](02-package-and-resource-normalization.md)
3. [03-runtime-lifecycle-and-state.md](03-runtime-lifecycle-and-state.md)
4. [04-safety-and-deterministic-tools.md](04-safety-and-deterministic-tools.md)
5. [05-ui-modernization.md](05-ui-modernization.md)
   1. [05-01-ui-ownership-and-mode-contract.md](05-01-ui-ownership-and-mode-contract.md)
   2. [05-02-async-cached-snapshot-service.md](05-02-async-cached-snapshot-service.md)
   3. [05-03-surface-ownership-and-responsive-rendering.md](05-03-surface-ownership-and-responsive-rendering.md)
   4. [05-04-lifecycle-and-disposal-hardening.md](05-04-lifecycle-and-disposal-hardening.md)
   5. [05-05-gate-and-todo-interaction-refinement.md](05-05-gate-and-todo-interaction-refinement.md)
6. [06-catalog-and-scaffolding.md](06-catalog-and-scaffolding.md)
7. [07-release-and-contributor-qol.md](07-release-and-contributor-qol.md)

## Planning assumptions

- Analysis baseline is Pi 0.84.2, which was both installed and npm `latest` on 2026-08-21.
- Each phase is separately approved and implemented; planning does not authorize broad refactors.
- P0 safety/correctness fixes may be promoted ahead of larger phase work, but still require focused tests.
- Native Pi APIs and resources remain the source of truth; Gentic-specific abstractions must justify their maintenance cost.

## Global definition of done

- Updated lockfile and declared direct dependencies reproduce locally and in CI.
- Compatibility checks compare Gentic with pinned Pi types and fail on drift.
- Tests, typecheck, resource validation, and anatomy checks pass.
- Every plugin has explicit mode, lifecycle, state, UI ownership, and verification documentation.
- No abandoned compatibility shim or duplicated user-facing surface remains without a recorded decision.

## Maintainer decisions before implementation

- Pi support policy: exact minor, compatible range, or continuous latest.
- Private package versus publishable npm/git package.
- Core versus optional plugin profile.
- Future of primitives.
- Canonical SWE resource type.
- Default todo enforcement and HUD display mode.
- Mandatory, generated, or removed anatomy declarations.

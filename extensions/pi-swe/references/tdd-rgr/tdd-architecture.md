# TDD Architecture

TDD shapes code by forcing behavior to be observable before design is generalized.

## Design pressure to keep

- Test through stable boundaries: public functions, command handlers, extension events, or user-visible resources.
- Mock only slow or external dependencies. Do not mock away the behavior under test.
- Prefer small seams over large dependency frameworks.
- Keep tests named after behavior, not implementation details.

## Useful test levels

- **Unit** for deterministic functions and small policies.
- **Integration** for file/resource discovery, config loading, adapters, and event wiring.
- **End-to-end** for complete command or package behavior.
- **Characterization** when changing legacy behavior whose current contract is not yet explicit.

## Refactor signals

Refactor after green when tests reveal:

- duplicated setup that hides intent
- awkward construction or missing seam
- names that do not match domain language
- broad assertions that should be narrower

Stop when the tested behavior is clear and the slice remains small.

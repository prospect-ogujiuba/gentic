# Red, Green, Refactor

## Red

- State the next observable behavior.
- Add one failing test or characterization.
- Confirm the failure is for the expected reason.
- Do not change production code before the failing check exists unless the work is test harness setup.

## Green

- Implement the smallest production change.
- Prefer simple code over generalized abstractions.
- Stop as soon as the focused test passes.
- Keep unrelated formatting, cleanup, and future cases out of the slice.

## Refactor

- Refactor only after the focused test is green.
- Preserve behavior; do not add new requirements during cleanup.
- Rerun the focused test after each meaningful cleanup.
- If cleanup reveals another behavior, write it down for a later slice.

## Verification

- **Focused**: the new or changed test.
- **Nearby**: tests for touched module, resource, or adapter.
- **Broader**: package or repo checks when public behavior, command discovery, or shared runtime paths changed.

Use the lightest verification that honestly covers the risk.

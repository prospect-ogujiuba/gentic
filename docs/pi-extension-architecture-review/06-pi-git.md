# 6. `pi-git` — basically good

> Shared review context: [overall verdict, comparison table, and priority order](./README.md).

## Verdict

**Good, slightly monolithic**

## Findings

`pi-git` has:

- a narrow contract
- bounded subprocess execution
- cancellation
- output limits
- structured errors
- a small public surface

The main concern is concentration.

`snapshot.ts` accounts for roughly 287 of 327 lines and combines:

- process supervision
- Git collection
- parsing
- rendering

There is also an architectural side effect elsewhere: HUD's direct reuse of `execBounded` has accidentally turned this internal helper into a de facto public API.

## Recommended fix

Extract a supported bounded-process utility and separate Git parsing from rendering.

No redesign is needed.

## Related priorities

This contributes to priority **#6** in the [shared priority order](./README.md#priority-order).

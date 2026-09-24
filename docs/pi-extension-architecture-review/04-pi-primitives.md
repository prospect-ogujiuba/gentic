# 4. `pi-primitives` — a plugin system inside a plugin system

> Shared review context: [overall verdict, comparison table, and priority order](./README.md).

## Verdict

**Wrong abstraction**

## Findings

`pi-primitives` recreates:

- discovery
- enablement
- isolation
- configuration
- trigger matching
- resource loading
- diagnostics
- registration order

It does this inside one Pi extension even though Pi already has native extensions, skills, prompts, and package discovery.

The explicit registry in `index.ts` means adding a primitive still requires editing a central barrel.

`config.json` creates another enable/disable mechanism alongside package profiles.

As a result, “primitive” becomes a parallel resource type that maintainers must learn and maintain.

The implementation is bounded and fuzz-tested, but the abstraction itself is obsolete.

## Recommended fix

Migrate each primitive to native Pi resources or extensions, then delete the internal framework.

## Related priorities

This maps directly to priority **#3** in the [shared priority order](./README.md#priority-order).

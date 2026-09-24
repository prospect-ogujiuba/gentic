# 2. `pi-swe` — several products welded together

> Shared review context: [overall verdict, comparison table, and priority order](./README.md).

## Verdict

**Overgrown / poorly bounded**

## Findings

At roughly 3,500 lines, `pi-swe` owns:

- durable initiative authority
- lifecycle/domain rules
- verification capture
- revision history
- completion commits
- planning prompts
- context injection
- modal/docket UI
- standalone todos
- workflow-backed todos

`registerSweSurface()` alone manages:

- service caches
- focus restoration
- automatic continuation
- context rewriting
- tool observation
- command dispatch
- UI
- todo registration

`todo` is not an SWE implementation detail, yet disabling `pi-swe` removes the lightweight todo system too.

There is also substantial runtime state in maps and single mutable slots:

- `services`
- `focused`
- `completionCwd`
- `SweService.#selected`
- `SweService.#verificationInitiative`
- `VerificationCollector.#pending`

The implementation defends these carefully, but the design creates avoidable session-lifetime and routing complexity.

## Recommended fix

Split the extension into:

- `pi-todo`
- `pi-swe-core`
- an optional SWE UI/automation adapter

Keep workflow projection as an integration contract rather than folding todo ownership into SWE.

## Related priorities

This maps directly to priority **#2** in the [shared priority order](./README.md#priority-order).

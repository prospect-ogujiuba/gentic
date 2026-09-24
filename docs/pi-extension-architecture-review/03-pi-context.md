# 3. `pi-context` — defensive complexity overwhelms the feature

> Shared review context: [overall verdict, comparison table, and priority order](./README.md).

## Verdict

**Overengineered**

## Findings

One command with no tool registration requires roughly 1,584 lines.

`native-snapshot.ts` alone is about 560 lines and recursively walks arbitrary runtime objects with:

- getter guards
- cycle tracking
- node budgets
- depth budgets
- property budgets
- truncation diagnostics
- sanitization
- contributor classification
- formatting
- pressure conversion

That is effectively a miniature safe object-inspection engine.

Much of this machinery exists because the extension derives contributor estimates from loosely typed Pi internals instead of consuming a stable telemetry contract.

The code is impressive, but the cost/value ratio is poor. It remains sensitive to undocumented runtime object shapes while appearing “safe” because every access is wrapped.

## Recommended fix

Pi should expose a typed, bounded context telemetry snapshot.

Until that exists:

- drastically reduce contributor analysis
- rely primarily on authoritative aggregate usage
- avoid recursively interpreting loosely typed runtime internals

## Related priorities

This maps directly to priority **#5** in the [shared priority order](./README.md#priority-order).

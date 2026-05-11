# DSA decision rubric

Use this rubric before changing a representation or introducing a specialized data structure.

## 1. Capture facts before choosing

Separate facts from wishes:

- Semantic requirements: uniqueness, ordering, range queries, prefix search, overlap detection, priority ordering, persistence, concurrency, exactness, API compatibility.
- Optimization wishes: faster lookup, lower latency, less memory, fewer allocations, simpler maintenance.
- Evidence level: measured, inferred, or speculative.

If evidence is speculative and semantics are already satisfied, prefer **measure first** or **no change**.

## 2. Identify workload shape

Record only what matters for the decision:

- dominant operations and their frequency
- current and expected cardinality
- read/write/update pattern
- ordering, range, prefix, overlap, priority, graph, streaming, or aggregation needs
- latency, throughput, memory, persistence, recovery, and concurrency constraints
- migration risk and API compatibility requirements

## 3. Start from default picks

Use the simplest idiomatic baseline that satisfies requirements:

- sequence / random access: dynamic array, vector, slice, list
- keyed lookup: hash map
- membership / uniqueness: hash set or bitset for bounded integer domains
- FIFO / LIFO: queue, deque, stack
- bounded stream: ring buffer
- repeated min/max or top-k: heap / priority queue
- sorted iteration or range query: sorted array for mostly-static data, ordered map/tree for dynamic data
- prefix lookup: trie or radix tree
- sparse relationships: adjacency list graph
- repeated connectivity merges: union-find
- overlap queries: interval tree
- persisted ordered index: B-tree / B+ tree
- recency cache: hash map + linked list or runtime LRU primitive

## 4. Decide whether to change

Change when:

- the current structure does not encode required semantics
- a hot or high-growth path repeatedly scans where indexing is clearly needed
- ordering/range/priority/overlap requirements are awkward or bug-prone in the current representation
- a composite structure would clarify source of truth plus maintained accelerator
- measured or strongly inferred evidence shows the current asymptotic behavior matters

Keep current structure when:

- data is small, bounded, cold, or ephemeral
- the performance concern is hypothetical
- simpler code already satisfies semantics and constraints
- migration/API churn costs more than the likely benefit

## 5. Compare realistic candidates

For each serious candidate, compare:

- supported and weak operations
- before/after complexity
- memory overhead and locality
- implementation complexity and standard-library support
- fit with current code and tests
- migration, backfill, synchronization, or persistence risk

A good recommendation names the current approach, the recommended approach, and at least one rejected alternative when the decision is non-obvious.

## 6. Output template

### DSA assessment

**Problem summary**
- Behavior needed and decision being made.

**Current implementation**
- Current structure and access pattern.
- Evidence that it is adequate or problematic.

**Workload / constraints**
- Dominant operations, data size/growth, read/write balance, and required semantics.

**Recommendation**
- Structure and algorithm/access pattern.
- Change decision: change, no change, measure first, or not applicable.

**Rejected alternatives**
- Alternative and why it was not chosen.

**Complexity impact**
- Before and after time complexity plus practical constants.

**Memory tradeoff**
- Extra storage, allocation, cache locality, and maintenance overhead.

**Migration advice**
- Smallest safe change, compatibility notes, rollback path.

**Validation plan**
- Tests, benchmark, instrumentation, or manual checks.

**Confidence**
- High, medium, or low with evidence reason.

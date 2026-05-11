# DSA algorithm playbook

Choose algorithms with the data representation. The right structure should make the dominant algorithm simple and explicit.

## Common problem shapes

### Repeated keyed lookup, membership, or deduplication

Use a hash map for lookup by key, a hash set for membership, or a bitset when the domain is bounded. Prefer pre-index-once/query-many over repeated scans when the path is hot or high-growth.

### Ordered lookup, predecessor/successor, or range queries

Use a sorted array plus binary search for mostly-static data, an ordered map/tree for mutable ordered data, or a B-tree/B+ tree for persisted/block-oriented indexes. Avoid sorting on every query.

### Priority, scheduling, or top-k

Use a heap or priority queue. For bounded top-k, keep a heap of size k instead of sorting all data. Use lazy deletion only when arbitrary removals are rare and stale entries are safe to discard on pop.

### FIFO, buffering, and streaming windows

Use a queue/deque for work ordering, a ring buffer for bounded recent history, and a monotonic queue for sliding-window min/max. Model the window invariant directly instead of nested rescans.

### Graph relationships, dependencies, and reachability

Use adjacency lists for sparse graphs and adjacency matrices only for dense small fixed graphs. Use BFS for unweighted shortest paths, DFS for reachability/cycle checks, topological sort for DAG ordering, Dijkstra for non-negative weighted paths, and union-find for merge-only connectivity.

### Text, tokens, and search

Use a trie/radix tree for prefix workloads, an inverted index for document/token search, KMP-style prefix tables for repeated exact-pattern matching, and suffix arrays only for heavy offline substring search.

### Range aggregation and intervals

Use prefix sums for immutable range sums, difference arrays for many range updates followed by one materialization, Fenwick trees for mutable prefix aggregates, segment trees for broader mutable range queries, sparse tables for static idempotent range queries, and interval trees for overlap queries.

### Caching and eviction

Use memoization for deterministic repeated computation, LRU for recency-sensitive caches, and LFU only when stable hotness matters enough to justify complexity. Keep cache key choice and invalidation explicit.

### Approximate answers at scale

Use Bloom filters for approximate membership, HyperLogLog for approximate distinct counts, and Count-Min Sketch for approximate frequencies only when false positives or approximation error are acceptable.

## Pattern triggers

- Binary search requires sorted data or a monotonic predicate.
- Two pointers require monotonic movement over an ordered sequence.
- Sliding window requires a contiguous range and maintainable invariant.
- Greedy requires a correctness argument; otherwise compare with dynamic programming.
- Dynamic programming requires state, transition, base cases, and overlapping subproblems.
- Backtracking needs pruning, input bounds, and fail-fast behavior.
- Topological sort must detect cycles.
- Dijkstra requires non-negative edge weights.
- Bit masks require a bounded domain and named constants.

## Anti-pattern checks

- repeated `find`, `filter`, or nested scans in a hot path where an index is obvious
- sorting on every query instead of sorting once or maintaining order
- using arrays for uniqueness when size is unbounded and membership dominates
- using a hash map when sorted iteration or range queries are semantic requirements
- adding a specialized tree/sketch/trie without evidence or semantic need
- replacing a simple local representation with a broad migration when a small maintained index would solve the issue

## Validation shortcuts

- Add focused invariant tests for semantics such as uniqueness, ordering, overlap, or priority.
- Benchmark before/after when performance motivates the change.
- Instrument cardinality and operation counts when workload assumptions are unknown.
- Check memory and allocation pressure when adding indexes, caches, trees, or sketches.

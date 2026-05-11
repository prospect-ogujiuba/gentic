# Data structures catalog

Use this compact routing catalog after the decision rubric identifies the real workload. Prefer language/runtime standard-library structures unless a specialized invariant is required.

## Core collections

- Dynamic array / vector / slice / list: default dense sequence, random access, append, iteration, cache locality. Weak for frequent middle insert/delete or keyed lookup.
- Linked list: stable node identity and cheap insert/delete after a known node. Weak for random access and cache locality; rarely the default.
- Stack: LIFO control flow, parsing, undo, DFS.
- Queue / deque: FIFO work, double-ended operations, producer/consumer flows.
- Ring buffer: bounded queue or recent-history window with fixed memory.

## Hashing and indexing

- Hash map: lookup/update by key, grouping, frequency counts, memoization.
- Hash set: membership, uniqueness, deduplication.
- Bitset / bitmap: compact membership for bounded integer or enum domains.
- Bloom filter: approximate membership when false positives are acceptable.
- Count-Min Sketch / HyperLogLog: approximate frequency or cardinality at scale.

## Ordered and tree structures

- Sorted array: mostly-static ordered data, binary search, compact memory.
- Ordered map/set or balanced tree: mutable sorted iteration, predecessor/successor, range queries.
- B-tree / B+ tree: persisted or block-oriented ordered indexes.
- Skip list: probabilistic ordered map/set where library/runtime support exists.
- Order-statistic tree: rank/select queries when maintained counts are needed.

## Priority structures

- Heap / priority queue: repeated min/max extraction, scheduling, top-k, graph algorithms.
- Min-max heap: both extremes matter frequently.
- Monotonic queue/stack: sliding-window extrema or next-greater/next-smaller patterns.

## Graph and connectivity structures

- Adjacency list: sparse graph traversal and dependency graphs.
- Adjacency matrix: dense small fixed graphs with constant-time edge checks.
- DAG plus indegree map: dependency ordering and topological sort.
- Union-find: repeated connectivity queries under merge-only updates.
- CSR/sparse matrix forms: compact static large sparse graphs or numeric workloads.

## Range, interval, and aggregation

- Prefix sum: immutable range sums.
- Difference array: many range updates followed by one materialization.
- Fenwick tree: mutable prefix/range sums with compact memory.
- Segment tree: mutable range queries/updates over associative operations.
- Sparse table: static idempotent range queries with preprocessing.
- Interval tree: overlap queries over time spans or ranges.
- kd-tree / R-tree / quadtree: spatial or multidimensional filtering.

## Strings, text, and search

- Trie / radix tree: prefix lookup, autocomplete, token routing.
- Inverted index: document/code/token search.
- Suffix array/tree: heavy offline substring search.
- Rope / piece table / gap buffer: text editing with localized mutations.
- String interning: repeated equality checks over many duplicate strings.

## Composite structures

- LRU cache: hash map plus recency list.
- Append-only log plus secondary index: stable source of truth plus fast lookup.
- Graph plus maps/sets: traversal with explicit visited, parent, distance, or indegree state.
- Cache plus invalidation metadata: derived accelerator over a simpler source of truth.

## Practical defaults

- Small, bounded, cold data: keep arrays/lists and linear scans.
- Repeated lookup by id: hash map.
- Repeated membership/uniqueness: hash set or bitset for bounded domains.
- Sorted iteration or range semantics: sorted array, ordered map/tree, or B-tree for persisted data.
- Repeated priority extraction: heap/priority queue.
- Prefix search: trie/radix tree.
- Dependencies/reachability: graph with adjacency list.
- Connectivity under merges: union-find.
- Sliding windows: deque, ring buffer, or monotonic queue.
- Time interval overlaps: interval tree.

## Memory and migration reminders

Extra indexes and caches duplicate state. Name the source of truth, define update/invalidation rules, and test consistency. Prefer no change when a simpler representation is correct, bounded, and not evidenced as a bottleneck.

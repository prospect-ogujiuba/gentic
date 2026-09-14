# Native metadata scan comparison

The T3 integration test instruments `getCommands()` and `getAllTools()` calls per discovery operation.

| Implementation | Command scans | Tool scans | Outcome |
| --- | ---: | ---: | --- |
| Legacy static `/catalog status` baseline | 0 | 0 | Rejected `status`; returned the pinned static capability catalog. |
| Native metadata implementation | 1 | 1 | Returns runtime status/search results. |

One snapshot is created per command or tool invocation and reused for formatting, filtering, counts, and structured details. The test asserts cumulative scan counts after status, command search, and tool search to prevent redundant metadata queries.

# Bounded native context snapshot design

## Decision

Replace the maintained context ledger with a snapshot built only when `/pi-context`, an explicit export, or the HUD adapter requests one. The builder receives an `ExtensionCommandContext`-compatible view and calls each native source once:

1. `ctx.getContextUsage()` for used tokens, context window, remaining tokens, and remaining percentage.
2. `ctx.getSystemPromptOptions()` for aggregate system-prompt contributors.
3. `ctx.sessionManager.getBranch()` for aggregate contributors on the active branch only.

The executable contract is `extensions/pi-context/src/app/native-snapshot-contract.ts`.

## Public schema

The version-1 snapshot contains only:

- capture time and schema version;
- numeric context usage;
- broad contributor kind, item count, byte count, and optional token count;
- branch total/scanned counts and truncation state;
- bounded diagnostic codes;
- the applied resource bounds.

Contributor kinds are fixed enums: system prompt, active tools, context files, skills, user messages, assistant messages, tool results, and other session entries. Contributor records never contain content-derived labels.

## Bounds and algorithm

| Input/output | Limit | Rule |
|---|---:|---|
| Active branch entries scanned | 512 | Scan the newest bounded suffix; report total and truncation. |
| Context files inspected | 64 | Count and measure locally, then discard paths and content. |
| Skills inspected | 64 | Count and measure locally, then discard names, paths, and content. |
| Active tools inspected | 64 | Count and measure locally, then discard names and snippets. |
| Prompt guidelines inspected | 64 | Measure locally, then discard content. |
| Content blocks per measured value | 64 | Ignore the remaining suffix and emit `content-truncated`. |
| Object properties per measured value | 32 | Ignore additional properties and emit `content-truncated`. |
| Nodes traversed per measured value | 256 | Stop recursive measurement and emit `content-truncated`. |
| Value traversal depth | 4 | Stop nested traversal and emit `content-truncated`. |
| Characters measured per value | 65,536 | Measure only the bounded prefix and emit `content-truncated`. |
| Contributor groups returned | 8 | Aggregate by fixed kind, deterministically order, then truncate. |
| Diagnostic codes returned | 4 | Deduplicate fixed enum codes, then truncate. |

Top-level work is `O(min(branch, 512) + min(contextFiles, 64) + min(skills, 64) + min(tools, 64) + min(guidelines, 64))`. Every measured value additionally has fixed node, depth, property, block, and character budgets. Retained snapshot space is `O(8 + 4)` and does not scale with session length or content size.

The builder must not retain a copy of Pi inputs after returning. It reads arrays by index within each bound, accumulates numeric counters, and stores no source object references. Any input truncation maps to the fixed `prompt-options-truncated` or `content-truncated` diagnostic rather than copying source details.

## Security and trust boundaries

`getSystemPromptOptions()` and active-branch entries are trusted Pi structures but contain untrusted and potentially secret user, assistant, tool, context-file, skill, path, and credential content. The builder may inspect content only to calculate numeric size/count aggregates in process. It must never copy or derive externally recognizable text.

Disallowed snapshot/export fields include:

- prompt, message, tool argument/result, or context-file content;
- previews, labels derived from content, hashes, IDs, or timestamps from branch entries;
- filesystem paths, working directories, package/skill/tool names, provider/model/session identifiers;
- arbitrary exception text or configuration diagnostics.

Errors map to fixed `NativeSnapshotDiagnostic` codes. No external calls, filesystem scans, authorization changes, or automatic compaction occur.

## Explicit exclusions

The design has no streaming or per-tool execution ledger. It does not subscribe to `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, or `tool_result`. It does not use `getEntries()` or `getTree()`, because those include abandoned branches. It does not reconstruct a parallel session history or persist intermediate observations.

Pressure hysteresis remains the only justified small cross-snapshot state; it retains numeric level/arming/timestamp values only. Export generation consumes the same bounded public snapshot as terminal and HUD output.

## Baseline and target

A registration probe before this design found 26 lifecycle subscriptions: 7 streaming/per-tool forensic subscriptions, including 2 update-stream subscriptions. The native snapshot contract requires 0 of those 7 subscriptions. T5 will remove them from runtime registration; T6 must repeat the same registration probe and confirm zero.

Snapshot qualification must also pass adversarial markers through prompts, context files, skill content, branch messages, tool arguments/results, IDs, labels, paths, and thrown errors, then confirm no marker appears in the snapshot, summary, HUD, Markdown, or JSON.

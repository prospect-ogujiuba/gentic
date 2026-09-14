# Consolidated Gentic discovery contract

## Public surface

Gentic has one user-facing discovery command: **`/catalog`**. The paired model-callable tool remains **`gentic_catalog`**. Both expose the same two operations:

| Operation | Command | Tool input | Outcome |
| --- | --- | --- | --- |
| Status (default) | `/catalog` or `/catalog status` | `{ "operation": "status" }` or omitted | Concise package/session status plus registered command/tool counts and sorted owners. |
| Search | `/catalog search <term>` | `{ "operation": "search", "query": "<term>" }` | Case-insensitive matches from registered command/tool names, descriptions, and canonical `sourceInfo`. |

Runtime discovery reads `pi.getCommands()` and `pi.getAllTools()`. Ownership is derived only from canonical `sourceInfo`; missing ownership is shown as `unknown`, not guessed from names.

## Output and interaction rules

- Status uses stable text headings for `commands` and `tools`, with counts and sorted owners.
- Search groups results under `Commands` and `Tools`; command rows show their directly invokable `/<name>` form and tool rows show the tool name.
- `/catalog search` without a non-whitespace term reports `Usage: /catalog search <term>` as a warning.
- No matches reports `No commands or tools matched: <term>` as a warning.
- Unknown operations report the compact usage string `/catalog [status|search <term>]` as a warning.
- Argument completions expose only `status` and `search`, each with an action-oriented description. All functionality remains keyboard-accessible through normal slash-command entry and does not depend on color or transient UI state.
- The tool returns the same text contract plus structured counts and matched metadata in `details`.
- Search terms are limited to 200 characters. Search presentation and structured details retain at most 25 command and 25 tool matches, report truncation, and clip untrusted metadata fields; status still reports exact native totals. Owner presentation is limited to 50 sorted owners. These bounds prevent another extension's metadata from bloating command output or persisted tool results.

## Explicit boundaries

- The contract has no `run` or equivalent proxy operation. Results show direct command syntax; users invoke commands themselves.
- `/gentic`, `gentic_status`, and the static runtime catalog presentation are legacy overlapping surfaces to retire during the migration task, not aliases in this contract.
- `catalog/pi-native-capabilities.json` remains a deterministic build-time/release fixture owned by `scripts/generate-pi-catalog.ts` and `npm run generate:catalog` / `npm run check:catalog`.
- Runtime command/tool discovery never reads or regenerates that fixture.
- Reloading resources and feature-specific behavior remain owned by Pi and the respective extension commands.

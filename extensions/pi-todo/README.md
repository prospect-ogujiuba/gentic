# pi-todo

pi-todo is the Gentic todo ledger extension. It keeps agents on durable, claimable work and blocks non-todo tools until work is active.

Deterministic agent defaults:

- Use `todo({ "action": "begin" })` when no todo is active. It returns active work or starts the next ready todo.
- Use `todo({ "action": "finish", "summary": "..." })` to close active work. Existing attached evidence counts toward completion.
- Use `create_artifact` or `note_artifact` for generated durable notes/reports/plans so pi-todo creates the `.model-artifacts/<kind>/<topic>/...` path and attaches evidence automatically.
- Use `record_artifact` only for existing files.

## Intake organization and splitting

By default, `todo({ "action": "create", ... })` creates one explicit todo so progress stays aligned with the caller's intended unit of work.

Use `todo({ "action": "create_organized", ... })` or `todo({ "action": "create", "autoOrganize": true, ... })` when you intentionally want organized intake before persistence:

- Atomic requests create one directly workable todo.
- Compound requests are organized into a parent/container plus child todos in the same response. The parent records the decomposition and is not directly workable; start or begin a child todo instead.
- Vague requests return clarification questions instead of creating an underspecified todo unless explicit fallback is requested.

Use `todo({ "action": "split_check", "todoId": "..." })` to diagnose an already-created todo, and `todo({ "action": "split", "todoId": "...", "children": [...] })` when complexity is discovered after creation.

## Configuration

pi-todo reads `~/.pi/agent/pi-todo.json` and project `.pi/pi-todo.json`, with project values taking precedence. The `docket` and `enforcement` sections merge by field; if a project config supplies `enforcement.rules`, that rule list replaces the global rule list.

```json
{
  "docket": {
    "showCompletedFocus": false
  },
  "enforcement": {
    "defaultAction": "requireTodo",
    "rules": [
      { "pattern": "read", "action": "allow" },
      { "pattern": "ctx_search", "action": "allow" },
      { "pattern": "ctx_stats", "action": "allow" },
      { "pattern": "ctx_doctor", "action": "allow" },
      { "pattern": "context_mode_ctx_search", "action": "allow" },
      { "pattern": "context_mode_ctx_stats", "action": "allow" },
      { "pattern": "context_mode_ctx_doctor", "action": "allow" },
      { "pattern": "web_search", "action": "allow" },
      { "pattern": "code_search", "action": "allow" },
      { "pattern": "fetch_content", "action": "allow" },
      { "pattern": "get_search_content", "action": "allow" },
      { "pattern": "edit", "action": "requireTodo" },
      { "pattern": "write", "action": "requireTodo" },
      { "pattern": "bash", "action": "requireTodo" }
    ]
  }
}
```

Set `docket.showCompletedFocus` to `false` to hide the last completed task chip once all tasks are closed. The default is `true`, so the docket keeps showing the latest completed work for handoff visibility.

`enforcement.defaultAction` is `requireTodo` by default, preserving strict behavior for mutating, executable, and unknown tools. The `todo` tool is always allowed so agents can start work. Add exact `enforcement.rules` to allow low-risk inspection tools before a todo is active: built-in tools such as `read`, safe context lookup/status tools such as `ctx_search`, `ctx_stats`, `ctx_doctor` and their `context_mode_ctx_*` equivalents, and third-party/search tools such as `web_search` or `code_search`. Keep mutating tools (`edit`, `write`), command/code execution tools (`bash`, `ctx_execute`, `ctx_execute_file`, `context_mode_ctx_execute`, `context_mode_ctx_execute_file`, deploy tools), and broad third-party patterns at `requireTodo`; explicit `requireTodo` rules always take precedence over `allow` rules, even when the `allow` rule is more specific.

### Enforcement migration modes

- **Strict (default/current behavior):** omit `enforcement` or set `defaultAction` to `requireTodo`. Use this for teams that want every non-`todo` tool to require active work unless an allow rule matches.
- **Relaxed inspection-first:** keep `defaultAction: "requireTodo"`, then allow specific read-only or research tools. This reduces startup friction while preserving todo gates for mutating tools.
- **Disabled/global allow:** set `defaultAction` to `allow` only when you explicitly want pi-todo to stop blocking tools before active work. Add `requireTodo` rules for any tools that must stay gated; the `todo` tool remains allowed either way. If any invalid enforcement entry is detected while the effective default action is `allow`, pi-todo fails closed by forcing the effective default action back to `requireTodo` and reports config diagnostics on the blocked tool path.

Recommended relaxed allowlist:

```json
{
  "enforcement": {
    "defaultAction": "requireTodo",
    "rules": [
      { "pattern": "read", "action": "allow" },
      { "pattern": "ctx_search", "action": "allow" },
      { "pattern": "ctx_stats", "action": "allow" },
      { "pattern": "ctx_doctor", "action": "allow" },
      { "pattern": "context_mode_ctx_search", "action": "allow" },
      { "pattern": "context_mode_ctx_stats", "action": "allow" },
      { "pattern": "context_mode_ctx_doctor", "action": "allow" },
      { "pattern": "web_search", "action": "allow" },
      { "pattern": "code_search", "action": "allow" },
      { "pattern": "fetch_content", "action": "allow" },
      { "pattern": "get_search_content", "action": "allow" },
      { "pattern": "edit", "action": "requireTodo" },
      { "pattern": "write", "action": "requireTodo" },
      { "pattern": "bash", "action": "requireTodo" }
    ]
  }
}
```

Recommended disabled mode with mutating safeguards:

```json
{
  "enforcement": {
    "defaultAction": "allow",
    "rules": [
      { "pattern": "edit", "action": "requireTodo" },
      { "pattern": "write", "action": "requireTodo" },
      { "pattern": "bash", "action": "requireTodo" }
    ]
  }
}
```

Migration note: existing users keep strict behavior automatically because the default remains `requireTodo`. To relax enforcement, add rules incrementally in project `.pi/pi-todo.json`; project `enforcement.rules` replace the global rule list, so copy any global allowlist entries you still need.

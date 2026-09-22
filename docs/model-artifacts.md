# Model artifacts

Model artifacts are durable files created by a model or model-driven workflow. Gentic keeps them separate from curated human documentation and places them by ownership and purpose.

## Canonical layout

Initiative artifacts belong beneath:

```text
.model-artifacts/initiatives/<topic>/<kind>/YYYY-MM-DD_HHMM-<short-name>.md
```

`<topic>` and `<short-name>` are kebab-case. Initiative kinds are exactly:

- `specs`
- `plans`
- `todo`
- `findings`
- `reports`
- `logs`

Repository-wide reports and runtime logs belong beneath:

```text
.model-artifacts/system/reports/[namespace]/YYYY-MM-DD_HHMM-<short-name>.md
.model-artifacts/system/logs/[namespace]/YYYY-MM-DD_HHMM-<short-name>.md
```

A system namespace is optional and must be kebab-case.

## Creation

Use the `artifact` tool for model-generated Markdown. It validates the requested scope, topic, kind, namespace, and short name; generates the UTC timestamp; and publishes the file atomically without overwriting an existing artifact when writers cooperate. The tool assumes a trusted local worktree; it is not a sandbox against another process concurrently replacing artifact parent directories.

Example:

```text
artifact {
  scope: "initiative",
  topic: "pi-work",
  kind: "reports",
  name: "implementation-review",
  content: "# Implementation review\n..."
}
```

The tool returns the canonical path, byte count, creation time, and SHA-256 content hash.

## Authority boundary

`.model-artifacts/initiatives/<topic>/workflow.json` is stable pi-swe authority. It is not a generic model artifact and cannot be created or modified through the `artifact` tool. Initial authority is published exclusively through the structured `swe create` action; `/swe plan <topic>` only reports the handoff and does not write a workflow. pi-swe may reference generated artifacts by their canonical path and verified content hash.

`docs/plans/` contains curated, stable, human-facing documentation only. Do not mirror generated plans there.

Keep scratch output transient. Persist it only when it provides useful plans, findings, review evidence, reports, or durable logs.

## Validation

Run:

```text
npm run check:model-artifacts
```

The checker rejects unsafe paths, symbolic links, unknown scopes or kinds, non-kebab initiative topics, and noncanonical initiative artifact filenames.

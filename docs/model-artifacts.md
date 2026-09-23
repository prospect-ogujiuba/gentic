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

## Version control policy

Use selective tracking rather than staging `.model-artifacts` wholesale:

| Path or kind | Default | Rationale |
| --- | --- | --- |
| `initiatives/<topic>/workflow.json` | Track for substantial or shared initiatives | Preserves durable SWE authority across clones, branches, sessions, and review. Commit the final authority for completed tracked initiatives. |
| `specs/` | Track when approved | Durable requirements and constraints belong with the implementation they govern. |
| `plans/` | Review individually | Track plans with lasting review value, but do not mirror or compete with `workflow.json`. |
| `findings/` | Review individually | Keep architectural, security, and investigation findings that future work needs. |
| `reports/` | Review individually | Keep final reviews, migration reports, and useful verification summaries. |
| `todo/` | Local by default | Working notes are usually transient; track only when they provide durable coordination value. |
| `logs/` | Ignore by default | Runtime and revision history is high-volume local operational noise. |

Never use `git add .model-artifacts` as a convenience. Select each workflow or Markdown artifact intentionally, and do not include unrelated initiative authority in the same change. One branch should normally have one owner mutating a tracked active workflow to avoid authority conflicts. Repository ignore rules exclude canonical initiative and system `logs/` directories while leaving workflows and reviewable artifact kinds visible to Git.

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

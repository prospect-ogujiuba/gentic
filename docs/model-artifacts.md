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

Use the `artifact` tool for model-generated Markdown. It validates the requested scope, topic, kind, namespace, and short name; generates the UTC timestamp; and delegates publication to `src/services/safe-file-publication.ts`. The shared backend bounds UTF-8 bytes, validates normalized project-relative `.model-artifacts` paths, rejects symlinked parents, opens the final parent through a stable directory-descriptor path, stages and syncs content, publishes by an exclusive parent-relative hard link, verifies that the canonical parent did not change, removes the staging file, and syncs directory entries. Existing destinations are never replaced; a runtime without `/proc/self/fd` or `/dev/fd` support fails closed.

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

## Publication safety matrix

The shared backend is intentionally limited to bounded UTF-8 publication beneath `.model-artifacts`; it is not a general filesystem framework.

| Case | Required result |
| --- | --- |
| Non-normalized, absolute, traversal, backslash, NUL, or outside-root path | Reject before creating directories or files. |
| `workflow.json` destination | Reject explicitly as `workflow-authority`. |
| Content above the caller's byte bound | Reject before publication. |
| Symlinked/non-directory ancestor or parent replacement before/during publication | Reject; parent-relative operations stay on the opened directory and do not write through the replacement. |
| Existing file or symlink destination | Report collision; never overwrite or follow it. |
| Interrupted staged write | Leave no destination or partial publication; remove the owned staging inode when possible. |
| Concurrent publishers for one destination | Exactly one exclusive link may succeed; losers report collision. |
| Successful publication | Preserve exact UTF-8 bytes; sync the staged file and created/final directories. |
| Cleanup after a path swap | Remove only a path whose device/inode still matches the backend-owned staging file. |

The focused matrix is executable in `test/safe-file-publication.test.ts` and `test/pi-safe-file-publication-characterization.test.ts`. The latter also locks pi-artifacts and pi-context paths, names, bytes, errors, and public size behavior.

## Authority boundary

`.model-artifacts/initiatives/<topic>/workflow.json` is stable pi-swe authority. It is not a generic model artifact. The shared backend rejects that basename for every caller, and neither pi-artifacts nor pi-context can create or modify it. Initial authority is published exclusively through the structured `swe create` action and pi-swe's private `SweService`/store path, which retains its stronger stable parent-relative and lifecycle-specific publication protocol; `/swe plan <topic>` only reports the handoff and does not write a workflow. pi-swe may reference generated artifacts by their canonical path and verified content hash.

`docs/plans/` contains curated, stable, human-facing documentation only. Do not mirror generated plans there.

Keep scratch output transient. Persist it only when it provides useful plans, findings, review evidence, reports, or durable logs.

## Validation

Run:

```text
npm run check:model-artifacts
```

The checker rejects unsafe paths, symbolic links, unknown scopes or kinds, non-kebab initiative topics, and noncanonical initiative artifact filenames.

# Model artifacts

`.model-artifacts/` is the repository home for generated analysis and coordination artifacts that should remain discoverable after an agent or human task ends.

## Kinds

Use one top-level directory per artifact kind:

| Kind | Use for |
| --- | --- |
| `reports` | Completed analysis, audits, reviews, summaries, or recommendation write-ups. |
| `plans` | Forward-looking implementation plans, phase contracts, migration plans, and task slices. |
| `findings` | Focused observations, investigation notes, defects, risks, or evidence that may feed a later report or plan. |
| `logs` | Curated command, verification, run, or experiment output that is useful as evidence. Keep noisy raw logs transient unless they are needed for review. |
| `specs` | Requirements, PRDs, interface contracts, and behavior specifications. |
| `todo` | Durable task-ledger artifacts created for or referenced by `pi-todo`. |

Prefer `reports` for what was learned, `plans` for what should happen next, and `findings` for smaller evidence or unresolved observations.

## Naming

Place artifacts under a topic subdirectory when possible:

```txt
.model-artifacts/<kind>/<topic>/<timestamp>-<kebab-case-short-name>.md
```

Use a sortable timestamp such as `YYYY-MM-DD_HHMM` followed by a short kebab-case name. Keep names descriptive enough to understand in directory listings.

Examples:

```txt
.model-artifacts/reports/gentic/2026-05-12_0833-architecture-refactor-recommendations.md
.model-artifacts/plans/gentic/2026-05-12_0833-phase-1a-model-artifacts-convention.md
.model-artifacts/todo/pi-todo/2026-05-12_1200-artifact-ledger-follow-up.md
```

## Source control and retention

Commit artifacts that document durable repo knowledge: accepted plans, completed reports, useful findings, specs, and review evidence. Keep task-local scratch, bulky raw logs, and reproducible command output out of source control unless a reviewer needs them.

If an artifact is only temporary coordination state, keep it task-local and remove or summarize it before handoff.

## Relationship to `pi-todo`

`pi-todo` is the durable task ledger. When a task creates or relies on a generated artifact, record the artifact path in the todo ledger with `todo action=record_artifact`. The file stays in `.model-artifacts/<kind>/...`; the todo record links the artifact to task history and evidence.

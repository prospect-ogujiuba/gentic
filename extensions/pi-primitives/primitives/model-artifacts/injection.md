# Model artifacts convention

- Generated analysis, coordination, planning, finding, log, spec, and todo artifacts that should outlive the current turn belong under `.model-artifacts/`.
- Use exactly one approved top-level kind: `reports`, `plans`, `findings`, `logs`, `specs`, or `todo`.
- Place artifacts under a topic directory: `.model-artifacts/<kind>/<topic>/<timestamp>-<short-name>.md`.
- Use sortable timestamps: `YYYY-MM-DD_HHMM`.
- Use kebab-case topic segments and short names.
- Prefer `.model-artifacts/todo/<topic>/...` for durable task-ledger artifacts.
- Keep scratch or bulky reproducible output transient unless it is useful review evidence.

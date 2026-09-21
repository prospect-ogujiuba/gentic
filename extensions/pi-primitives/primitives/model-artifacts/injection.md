# Model artifacts convention

- Create model-generated Markdown with the `artifact` tool so placement and publishing are validated.
- Initiative artifacts live beneath `.model-artifacts/initiatives/<topic>/<kind>/`.
- Initiative kinds are exactly `specs`, `plans`, `todo`, `findings`, `reports`, and `logs`.
- Store non-initiative runtime artifacts only beneath `.model-artifacts/system/logs/` or `.model-artifacts/system/reports/`.
- Use kebab-case topic, namespace, and short-name segments. Generated filenames have the shape `YYYY-MM-DD_HHMM-<short-name>.md`.
- Pi-swe `workflow.json` is stable initiative authority and is not a generic artifact.
- `docs/plans/` contains curated, stable, human-facing documentation only. Never mirror a canonical generated plan there.
- Keep scratch or bulky reproducible output transient unless it is useful review evidence.

# Model artifacts convention

- Model artifacts layout v2 stores initiative artifacts beneath `.model-artifacts/initiatives/<topic>/<kind>/`.
- Initiative kinds are exactly `specs`, `plans`, `todo`, `findings`, `reports`, and `logs`.
- Store non-initiative runtime and migration artifacts only beneath `.model-artifacts/system/logs/` or `.model-artifacts/system/reports/`.
- Use normalized project-relative POSIX paths, kebab-case topic segments and short names, and generated filenames shaped `YYYY-MM-DD_HHMM-<short-name>.md`.
- Pi-swe `workflow.json` is stable initiative authority; former contract files, `manifest.json`, and `contracts.json` are accepted as read-only migration history.
- A legacy kind-first topic is read-only and requires explicit migration; if the same topic exists in both layouts, stop with a blocking conflict instead of choosing one.
- `docs/plans/` contains curated, stable, human-facing documentation only. Never mirror a canonical generated plan there.
- Keep scratch or bulky reproducible output transient unless it is useful review evidence.

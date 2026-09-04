# Changelog

All notable Gentic changes are documented here. Versions follow the policy in `docs/release.md`.

## Unreleased

### Added

- Model-artifacts layout v2 operator guide, classified legacy-reference check, and retained rollback workflow.
- Version-stamped Pi capability catalog and source/manifest Gentic inventory.
- Project-aware atomic scaffolding for native Pi surfaces.
- Core/full native Pi package-filter profiles.
- Pi update drift reports, release verification, and performance budgets.
- Contributor, plugin, profile, and release guides.

### Changed

- Durable initiative artifacts now use `.model-artifacts/initiatives/<topic>/<kind>/`; system logs/reports use `.model-artifacts/system/` and v1 remains read-only during the 0.x migration window.
- Catalog UX is one hierarchical `/catalog` command plus one compact `gentic_catalog` tool.
- Anatomy declarations are optional handwritten records rather than generated requirements.
- Primitive loading isolates invalid imports/config/triggers and reports status.

## 0.1.0

- Initial private Git/local package baseline pinned to Pi 0.84.2.

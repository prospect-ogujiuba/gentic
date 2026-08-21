# Phase 7: Release and contributor quality of life

Created: 2026-08-21
Purpose: Keep Gentic aligned after the modernization rather than repeating a one-time upgrade.

## Goal

Automate update awareness, compatibility evidence, documentation, and optional package profiles.

## Scope

- Document install/update/reload, local development, verification, resource creation, and plugin ownership.
- Add an automated Pi update workflow: inspect changelog/types, update lock, run compatibility matrix, generate drift report.
- Decide publishable npm/git metadata and semantic versioning policy.
- Define core and optional plugin profiles without inventing non-native package resource kinds.
- Generate extension/resource inventory from source/manifest.
- Add changelog/release checklist and support-window policy.
- Add targeted performance budgets for context/HUD hot paths and startup/tool-schema overhead.

## Outputs

- Contributor guide and plugin template guide.
- Automated update/compatibility report.
- Release checklist and version policy.
- Generated inventory and optional profile documentation.

## Acceptance criteria

- A maintainer can add any supported native surface using one documented path.
- A Pi release drift is detected without manual catalog comparison.
- Release verification records Pi/Node versions and all check results.
- Optional plugins can be enabled without patching package internals.
- Documentation no longer claims missing anatomy/resources.

## Verification

- Dry-run an update from the pinned version to a fixture/newer version.
- Onboard from a clean checkout using only documented steps.
- Scaffold and load one representative new extension capability.
- Compare generated inventory with runtime registration smoke output.

## Open questions

- Publish target and release cadence?
- How long should older Pi minors remain supported?
- Which performance regressions should block release?

## Non-goals

- No commitment to add providers/subagents/MCP integrations unless separately approved.

# 7. `pi-artifacts` — best-designed extension

> Shared review context: [overall verdict, comparison table, and priority order](./README.md).

## Verdict

**Good**

## Findings

`pi-artifacts` has:

- one responsibility
- a thin registration layer
- explicit domain types
- canonical paths
- bounded content
- atomic publication
- clear security limitations

Its synchronous filesystem calls are acceptable because writes are small and infrequent.

The former secure-publication duplication with `pi-context` is resolved by the supported `src/services/safe-file-publication.ts` backend. pi-artifacts retains canonical naming, validation, metadata, and tool registration; pi-context retains rendering and export naming. The backend owns only bounded path validation, safe directory creation, staging, file/directory sync, exclusive atomic publication, collision handling, and inode-aware cleanup.

pi-swe deliberately does not use this backend. Its private `SweService`/store path remains the only writer of initiative `workflow.json` and retains stable parent-relative and lifecycle-specific authority publication. The shared backend explicitly denies `workflow.json`, so extracting common artifact/report mechanics does not broaden workflow authority.

## Resolution

No further safe-filesystem extraction is recommended. Extend the centralized adversarial matrix in `docs/model-artifacts.md` and its focused tests when adding a compatible artifact/report consumer; do not migrate unrelated writes or pi-swe authority publication.

## Related priorities

This contributes to priority **#6** in the [shared priority order](./README.md#priority-order).

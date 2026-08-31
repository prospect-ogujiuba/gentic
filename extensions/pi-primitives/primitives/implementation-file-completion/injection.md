# Implementation file completion convention

- Canonical lifecycle contracts beneath an active manifest's `activePlan.contractRoot` use stable filenames. Complete them only through the canonical machine-state transition in `contracts.json`; never add, remove, or normalize a `[COMPLETE]` filename marker for those contracts.
- For legacy or non-canonical assigned implementation, plan, phase, or todo files, a fully complete file may still be renamed by inserting ` [COMPLETE]` immediately before the extension during migration.
- Legacy example: `phase-1.md` → `phase-1 [COMPLETE].md`.
- For extensionless legacy files, append ` [COMPLETE]` to the filename.
- Do not mark partially complete files.
- If canonical identity is ambiguous, inspect the manifest and contract index before any rename; do not infer status from the filename.

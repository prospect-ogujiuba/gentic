# Primitive characterization and migration map

- `concise-output`: explicit extension policy hook on `before_agent_start`; unconditional bundled injection; exact-heading idempotence preserved.
- `implementation-file-completion`: explicit extension policy hook on `before_agent_start`; trigger data remains bundled and bounded; only prompt/options/context-file fields are scanned.
- `model-artifacts`: explicit extension policy hook on `before_agent_start`; trigger data remains bundled and bounded; artifact policy injection remains ordered after concise policy and before later handlers.
- `whimsical`: compatibility entry only; Pi owns the native working indicator; no competing turn hooks.
- Existing `extensions/pi-primitives` path and `config.json` remain stable for this release. `enabled`, `disabled`, unknown names, malformed JSON, duplicate names, byte limits, and bounded diagnostics remain compatibility behavior.
- `/scaffold` remains owned by `extensions/pi-commands` and is not removed or renamed.

Native boundary decision: retain one explicit extension policy bundle because these policies transform `before_agent_start`; remove generic primitive discovery/resource loading/registry abstractions from the runtime rather than recreating them under another name.
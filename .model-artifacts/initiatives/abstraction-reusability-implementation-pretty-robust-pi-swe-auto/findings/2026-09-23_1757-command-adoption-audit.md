# Command adoption audit

## Contract

The shared kernel remains limited to typed action presentation metadata, root prefix filtering, nested prefix assembly, help lines, and usage rendering. Parsing, state reads, candidate legality, execution, persistence, and domain messages remain extension-owned.

## Audited surfaces

- **pi-swe — adopted:** local action metadata now drives roots, quick-help syntax, and invalid usage; the adapter still owns initiative discovery, focus ranking, lifecycle filtering, work candidates, evidence blockers, parsing, and execution.
- **pi-todo — adopted:** a local adapter projects bounded branch state into legal action/todo/parent/sibling candidates, contextual descriptions and help, and recovery/follow-up messages. The branch core remains the only Todo state and transition authority.
- **catalog — adopted:** its two-action grammar benefits from generated described roots and invalid usage. Runtime discovery and search validation remain local.
- **scaffold — adopted at the root only:** scaffold-kind roots use shared filtering/descriptions. Its free-form name plus mutually exclusive variant/mode grammar, validation, transaction, and filesystem safety remain local.
- **pi-hud — adopted:** roots, mode prefix assembly, and invalid usage share one local action specification. Legacy migration parsing and display state remain local.
- **pi-context — deliberately unchanged:** mode and compatibility-filter tokens are order-independent and composable; the narrow action navigator would not model this grammar without becoming a generic parser. Existing local completion is retained and characterized.
- **clear and pi-git — deliberately unchanged:** both are no-argument commands with no meaningful nested choices.

## Compatibility boundary

No command names, tool schemas, persistence formats, lifecycle ownership rules, or non-TUI execution paths changed. Tests characterize positive, negative, partial-prefix, malformed/bounded Todo state, generated usage, local pi-context composition, and no-argument exclusions.

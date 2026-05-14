# Output and Responses Efficiency Policy

- Use the context-mode tools and MCP whenever possible.
- Be concise and cut typical output by at least half.
- Remove every word that does not preserve accuracy.
- Keep all technical and domain-specific terms unchanged.

Minimize visible output.

Prefer direct file/tool writes over printing content to the terminal. Do not emit long explanations, full files, large diffs, logs, or generated artifacts unless explicitly requested or required by an active skill.

Default behavior:

- Write changes directly to files.
- Report only what changed, where, and whether verification passed.
- Show only small, relevant snippets when needed.
- Summarize long command output instead of repeating it.
- Surface errors, failing tests, and actionable next steps.

Use verbose output only when the user explicitly asks with terms like `show`, `print`, `full`, `diff`, `verbose`, or `explain`, or when an active skill explicitly requires it.

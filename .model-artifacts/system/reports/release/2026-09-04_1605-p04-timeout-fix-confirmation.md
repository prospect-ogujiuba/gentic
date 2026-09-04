# Gentic release verification

Created: 2026-09-04T16:04:41.933Z
Purpose: Record reproducible release versions and all required verification results.

- Gentic: 0.1.0
- Pi: 0.84.2
- Node runtime: v26.3.1
- Node support: >=22.19.0

| Check | Exit | Result |
| --- | ---: | --- |
| `npm run typecheck` | 0 | passed |
| `npm run check` | 0 | passed |
| `npm run check:commands` | 0 | passed |
| `npm run check:performance` | 0 | passed |
| `npm test` | 1 | failed |

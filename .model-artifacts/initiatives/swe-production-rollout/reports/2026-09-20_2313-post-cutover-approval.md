# SWE v2 post-cutover approval

- Report kind: `swe-post-cutover-approval`
- Recorded at: `2026-09-20T23:13:15.257Z`
- Candidate commit: `08a434f642eef18a6d1adf5f7f2ce399e9c5b139`
- Runtime: `v2`
- Selector generation: `4`
- Selector preimage: `sha256:cd2a88739622adc3564d5c71b60bcc13808dad59d4bc90446e0992d274cb0f50`
- Handoff: `b4b173a1-7d07-41ce-be19-8bcd3278c4e0`
- Fresh parent runtime: `c76d9b21-5a84-4a90-9afe-86827434ad27`
- Controlling workflow revision: `28`
- Contract hash: `sha256:86e8fe19b206e5eb6ef855363518d975e81a9d0c03d6719455770d37bd4e0424`
- Initiative verification hash: `sha256:9e8f847161ae5cd895d89817b29cbf51b5274ff2f0a3a18a23e93ce40b5669e0`
- Verification: `npm run test:swe` passed 216/216; `npm run typecheck` passed; `git diff --check` passed.
- Recovery validation: compatibility rollback, v2 recutover, fenced-parent recovery, and v2-to-v2 fresh-parent rotation succeeded without rewriting accepted contract or initiative-verification evidence.
- Operator decision: the project owner explicitly directed immediate forward progress and closure of the compatibility rollback window on 2026-09-20.

## Approval

The default-v2 cutover and recovery behavior are approved. The compatibility rollback window may be closed immediately, and v1 execution paths may be retired while v1 readers and migration support remain available through Gentic 1.0.

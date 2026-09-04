# implementation-review

Created: 2026-09-04T19:56:04.500Z
Purpose: Durable implementation review decision for canonical contract P01-C01 revision 3.

# Implementation review: SWE completion resolution

- Mode: implementation-review
- Decision: request changes
- Reviewed context: topic `swe-completion-tool`; spec revision 1 (`sha256:16d95aab053b42030f4f3be6955409a971caa698f1c466ae714ba8977d33b299`); plan revision 3 (`sha256:7de975d94ef2e6e778f7dcc98dac4aa2fa327fd005e0bda737652bcb1acee6fb`); contract `P01-C01` at `.model-artifacts/initiatives/swe-completion-tool/plans/revisions/r3/phases/01-completion-resolution/01.01-completion-resolution.md` (`sha256:1b5270b9e7426e99eb597a8ed49043af0b4bfac4bce9618db33687c8e015174e`).
- Verification: `.model-artifacts/initiatives/swe-completion-tool/reports/2026-09-04_1928-verification.md` (`sha256:ccf757fa171679b52300856e4d476e66bb05340e2eef1c2b45184c004778f3c5`).
- Incorporated findings: `.model-artifacts/initiatives/swe-completion-tool/findings/2026-09-04_1627-tdd-plan.md`; `.model-artifacts/initiatives/swe-completion-tool/findings/2026-09-04_1627-completion-safety-compatibility.md`.
- Implementation: `extensions/pi-swe/src/completion-resolution.ts`, shared parser-only changes in `extensions/pi-swe/src/completion.ts`, and `test/pi-swe-completion.test.ts`.
- Prior implementation review: none.

## Findings

### F1 — High — phase grouping nodes are accepted as executable contracts

- Affected path: `extensions/pi-swe/src/completion-resolution.ts`, indexed-contract selection; `test/pi-swe-completion.test.ts`, resolver fixture.
- Violated requirement: P01-C01 acceptance criterion 1 and the approved plan rule that phase entries are non-executable grouping nodes.
- Evidence: the resolver accepts any `pending|in_progress` indexed item present in `readyIds`; it never rejects `indexed.kind === "phase"`. Every successful resolver test uses fixture contract `01` whose kind is `phase`, thereby asserting the prohibited behavior.
- Action: require the selected resolver contract to be an executable subphase (or the repository's canonical executable predicate) while retaining legacy phase compatibility only in the unchanged low-level transaction. Convert resolver-success fixtures to a phase plus active subphase and add an explicit active-phase rejection test.

### F2 — High — aggregate report budget is enforced after reading the boundary-crossing file

- Affected path: `extensions/pi-swe/src/completion-resolution.ts`, `scanReports`.
- Violated requirement: P01-C01 acceptance criterion 3 and the incorporated security decision to apply count, per-file, and aggregate limits before reading candidate bodies.
- Evidence: `readFileSync(absolutePath)` executes before `aggregateBytes += bytes.length` and the 16 MiB comparison. A file that crosses the aggregate budget is fully read first. Stat/read replacement races can likewise cause a grown file or swapped path to be read before the post-read rejection, weakening the promised bounded, non-symlink-following scan.
- Action: preflight the complete sorted direct-child set and reject when accumulated stat sizes exceed 16 MiB before reading any body; retain post-read accounting for races, and use a bounded non-symlink-following read/revalidation strategy so a replaced or grown file cannot bypass the resource and symlink boundary. Add a test seam proving the boundary-crossing body is not read and a replacement-race regression if the filesystem abstraction permits it.

## Verification implications

The recorded tests remain green but are insufficient for F1 and F2: the success fixture encodes a phase as executable, and the aggregate test proves eventual rejection rather than pre-read bounding. The verification artifact's `pass`/`gaps:none` conclusion is not eligible for completion until both findings are fixed and focused/full checks are rerun into a new verification artifact.

## Open blockers

- F1 and F2 are blocking in-contract correctness/security findings.
- The generated inventory delta remains assigned to dependent contract `P02-C01` and is not a blocker for this review.

## Residual risks

After the fixes, recheck parser compatibility, deterministic duplicate handling, transaction race delegation, and all journal/concurrency regressions.

## Next action

Return to `/skill:swe-implement` for the same exact `P01-C01` revision. Fix only executable-contract selection and pre-read bounded/no-follow report scanning, update focused tests, then rerun `/skill:swe-verify` and `/skill:swe-review`. No plan revision is required because both findings are within the approved contract.

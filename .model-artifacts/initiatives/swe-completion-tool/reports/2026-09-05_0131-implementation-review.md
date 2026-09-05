# Implementation review: SWE completion tool surface

- Mode: implementation-review
- Decision: approve
- Timestamp: 2026-09-05 01:31 UTC
- Topic: `swe-completion-tool`
- Contract: `P02-C01`, `.model-artifacts/initiatives/swe-completion-tool/plans/revisions/r3/phases/02-tool-surface/02.01-tool-surface.md`, plan revision 3, `sha256:c5cdd26bcf25c9e3b02cfb6c029cb020b31e40ab070fb2da5fa5cf29fd3960ee`
- Active spec: revision 1, `.model-artifacts/initiatives/swe-completion-tool/specs/2026-09-04_1627-initiative-spec-r1.md`, `sha256:16d95aab053b42030f4f3be6955409a971caa698f1c466ae714ba8977d33b299`
- Active approved plan: revision 3, `.model-artifacts/initiatives/swe-completion-tool/plans/2026-09-04_1627-plan-index-r3.md`, `sha256:7de975d94ef2e6e778f7dcc98dac4aa2fa327fd005e0bda737652bcb1acee6fb`
- Verification: `.model-artifacts/initiatives/swe-completion-tool/reports/2026-09-05_0125-verification.md`, `sha256:d28f8ae82fa280821596a310cafb9237c9a2b825d90f8788584eabcfdb1ba8b5`
- Incorporated findings: `.model-artifacts/initiatives/swe-completion-tool/findings/2026-09-04_1627-tdd-plan.md`; `.model-artifacts/initiatives/swe-completion-tool/findings/2026-09-04_1627-completion-safety-compatibility.md`
- Prior contract evidence: `.model-artifacts/initiatives/swe-completion-tool/reports/2026-09-04_2113-verification.md`; `.model-artifacts/initiatives/swe-completion-tool/reports/2026-09-04_2117-implementation-review.md`

Pi-SWE-Evidence: {"schemaVersion":1,"mode":"implementation-review","topic":"swe-completion-tool","contractId":"P02-C01","contractPath":".model-artifacts/initiatives/swe-completion-tool/plans/revisions/r3/phases/02-tool-surface/02.01-tool-surface.md","planRevision":3,"contractContentHash":"sha256:c5cdd26bcf25c9e3b02cfb6c029cb020b31e40ab070fb2da5fa5cf29fd3960ee","decision":"approve","blockingFindings":0,"verification":{"path":".model-artifacts/initiatives/swe-completion-tool/reports/2026-09-05_0125-verification.md","contentHash":"sha256:d28f8ae82fa280821596a310cafb9237c9a2b825d90f8788584eabcfdb1ba8b5"}}

## Findings

No blocking findings.

- Informational — `extensions/pi-swe/src/pi/tools.ts`: the adapter is narrow and additive. Exact confirmation precedes resolver I/O; caller input excludes hashes, paths, and revisions; one resolved request reaches the unchanged transaction; compact output preserves each disposition and actionable artifact metadata.
- Informational — `extensions/pi-swe/index.ts`, `test/pi-swe.test.ts`, `catalog/gentic-inventory.json`: registration is wired once, command/event behavior is unchanged, affected test doubles are updated, and generated inventory truthfully declares `swe_complete`.
- Informational — `test/pi-swe-completion.test.ts`: tool-level schema, refusal, default/clear propagation, resolver rejection, semantic result mapping, and real guarded completion are covered; unchanged transaction tests continue to cover replay, contention, recovery, normalization, and fault boundaries.
- Informational — `extensions/pi-swe/README.md`, `extensions/pi-swe/docs/e2e-scenarios.md`: documentation states concise input, constrained inference, fail-closed evidence selection, retained `/swe complete`, and non-autonomous behavior.

## Contract assessment

The eight `P02-C01` acceptance criteria are satisfied. The diff is limited to the approved adapter, wiring, tests/test doubles, documentation, and check-required generated inventory. No completion transaction, direct API, command parser, schema migration, recovery, lock behavior, legacy namespace, peer coupling, or autonomous lifecycle behavior changed.

## Verification implications

Verification is current and sufficient. Its single completion-eligible envelope matches the active contract path, revision, and content hash, and the whole-report hash matches this review. The acceptance map reports every criterion and planned item as pass with no gaps. Fresh evidence includes 10/10 focused selected tests, 36/36 completion regressions, 159/159 pi-swe tests, clean typecheck/checks, and 433/433 full tests.

## Open blockers

None.

## Residual risks

- Low: replay and separate-process contention remain proven primarily by the unchanged transaction regression suite rather than a second process-level harness around the thin tool adapter. The adapter adds no queue or mutation logic, and its one-call delegation plus real integration coverage make the existing evidence proportionate.
- Intentional: repositories retaining duplicate current approving reviews continue to fail closed until ambiguity is resolved.

## Next action

`P02-C01` revision 3 is approved for canonical completion using this review and the bound verification report. Invoke `swe_complete` with `confirm: true` or the retained low-level `/swe complete` interface; keep the canonical contract filename unchanged.

# Release and support policy

## Publish target and cadence

Gentic 0.x is a **private Git/local Pi package**, not an npm-published package. Releases are signed Git tags in the form `vMAJOR.MINOR.PATCH` from `main`, produced on demand after a pinned Pi update or a coherent Gentic change set. The `npm:gentic` name is not a supported install target while `package.json#private` is true.

Semantic versioning policy:

- patch: compatible fixes, docs, tests, and internal hardening;
- minor: new native surfaces, profile changes, or intentional behavior additions;
- major: removed/renamed public commands, tools, resources, profile contracts, or support-policy breaks.

During 0.x, breaking changes still require a minor bump and explicit `CHANGELOG.md` migration notes.

## Support window

Each Gentic release supports exactly the Pi minor pinned by all three `@earendil-works/pi-*` dependencies and recorded in `src/pi-contract.ts`. Older Pi minors receive no compatibility promise after a new Gentic tag; use the prior Git tag. Node support is `>=22.19.0`, verified on Node 22.19 and Node 24 in the update workflow.

## Pi update workflow

1. Preview upstream declarations and changelog without mutation:
   ```sh
   npm run pi:update -- --target <version> --report .model-artifacts/system/reports/pi-update/YYYY-MM-DD_HHMM-<version>.md
   ```
2. Review added/removed events, `ExtensionAPI` methods, catalog capability loss, and release notes.
3. On a dedicated branch, repeat with `--apply`. This updates all Pi pins and the lockfile, regenerates catalogs/inventory, and runs the compatibility matrix.
4. Resolve every failed matrix row. Do not suppress drift by editing generated JSON.
5. Run the `pi-update` GitHub workflow for Node 22.19 and 24 and retain its reports.

A drift report is expected to fail its candidate event row when upstream adds or removes an event: detection is the desired dry-run result.

## Blocking performance budgets

`npm run check:performance` blocks gross regressions in:

- context-to-HUD snapshot projection;
- representative HUD snapshot construction and start/update/shutdown lifecycle paths;
- responsive HUD footer rendering;
- all-extension startup registration (registration only, not command execution);
- source/manifest inventory generation;
- aggregate model-callable tool-schema size.

Budgets are intentionally broad wall-clock guardrails, not microbenchmark claims. Any budget increase requires measured evidence and a changelog entry; correctness must not be traded for a benchmark.

## Release checklist

- [ ] Working tree contains only the intended release scope.
- [ ] `CHANGELOG.md` has user-visible changes and migrations under the target version.
- [ ] `package.json`, lockfile, `src/pi-contract.ts`, and catalog source version agree.
- [ ] `npm ci` succeeds from a clean checkout.
- [ ] `npm run check:model-artifacts` reports no non-v2 artifacts or unclassified kind-first references.
- [ ] For a repository migration, the exact reviewed plan fingerprint, apply ledger, rollback bundle, pre/post audits, measured counts/bytes/durations, and restore rehearsal evidence are retained as described in [`model-artifacts.md`](model-artifacts.md).
- [ ] From a release shell with no active Pi todo, `npm run release:verify -- --active-todos 0 --report .model-artifacts/system/reports/release/YYYY-MM-DD_HHMM-release-verification.md` passes and records Pi/Node versions, every check, and read-only SWE cutover readiness.
- [ ] `catalog/pi-native-capabilities.json` and `catalog/gentic-inventory.json` are current.
- [ ] Core/full profile paths pass inventory validation.
- [ ] A temporary project scaffolds and smoke-loads one representative capability.
- [ ] Local Git install and `/reload` work using only `CONTRIBUTING.md`.
- [ ] CI and the Node compatibility workflow pass.
- [ ] Version follows the policy above; Git tag is signed and matches `package.json`.
- [ ] No npm publish is attempted while `private: true`.

## SWE production cutover readiness

`release:verify` performs a deterministic, read-only cutover check after every release command. `--active-todos 0` is an explicit operator observation: use it only when the release shell has no independent active todo. An omitted, malformed, or nonzero value fails closed. The report separates:

- **code:** supported Node (`>=22.19.0`), all three Pi pins matching `src/pi-contract.ts`, and every release command passing;
- **repository migration:** completed `migration-qualification`, a clean read-only migration inventory, and no active workflow except `swe-production-rollout`;
- **runtime activation:** completed `activation-qualification`, no independent active todo, and no active child run, retained workspace intent, SWE migration journal, or pi-artifacts claim/transaction recovery marker;
- **external release authorization:** always pending in the checker. A separate operator cutover decision is required.

Failure output is capped at 4096 bytes and contains exactly one next action. Inspection errors are redacted and block readiness. The check does not migrate a workflow, mutate `workflow.json`, clear recovery state, select a runtime, publish, or deploy. `READY` is evidence only and never authorizes activation.

### Cutover decision and rollback record

The responsible decision owner is the named release operator. Before changing the production default, that operator must record actor, rationale, UTC timestamp, candidate commit and signed tag, the reviewed readiness-report path and hash, and a rollback-window end time. Model-authored approval is invalid. The same owner, or an explicitly recorded successor, decides rollback and later retention cleanup.

Rollback is required during the window if any of these occurs: atomic registration or reload fails; startup reports mixed or ambiguous runtime selection; the post-cutover migration audit is not clean; an accepted workflow cannot resume from its durable checkpoint; workflow bytes, receipts, or evidence differ from the reviewed hashes; recovery state cannot be fenced; or a required release check regresses. Stop new managed execution, preserve the failing state, and use the separately authorized compatibility selector and symmetric fenced handoff. Never rewrite migrated workflow evidence or discard recovery material to make rollback pass.

Retain the readiness report and hash, operator decision, release-check report, pre/post migration audits, reviewed migration plans, per-topic receipts and rollback payloads, startup/reload logs, recovery records, retained workspace evidence, and rollback-rehearsal result for **at least 30 calendar days after cutover and through acceptance of the next signed Gentic release, whichever is later**. Legacy history remains read-only through the Gentic 1.0 compatibility boundary. Cleanup after the retention period is a separate destructive decision with recorded owner and evidence; it is not part of readiness or rollback.

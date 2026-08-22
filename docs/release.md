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
   npm run pi:update -- --target <version> --report .model-artifacts/reports/pi-update/YYYY-MM-DD_HHMM-<version>.md
   ```
2. Review added/removed events, `ExtensionAPI` methods, catalog capability loss, and release notes.
3. On a dedicated branch, repeat with `--apply`. This updates all Pi pins and the lockfile, regenerates catalogs/inventory, and runs the compatibility matrix.
4. Resolve every failed matrix row. Do not suppress drift by editing generated JSON.
5. Run the `pi-update` GitHub workflow for Node 22.19 and 24 and retain its reports.

A drift report is expected to fail its candidate event row when upstream adds or removes an event: detection is the desired dry-run result.

## Blocking performance budgets

`npm run check:performance` blocks gross regressions in:

- context-to-HUD snapshot projection;
- responsive HUD footer rendering;
- all-extension startup registration;
- source/manifest inventory generation;
- aggregate model-callable tool-schema size.

Budgets are intentionally broad wall-clock guardrails, not microbenchmark claims. Any budget increase requires measured evidence and a changelog entry; correctness must not be traded for a benchmark.

## Release checklist

- [ ] Working tree contains only the intended release scope.
- [ ] `CHANGELOG.md` has user-visible changes and migrations under the target version.
- [ ] `package.json`, lockfile, `src/pi-contract.ts`, and catalog source version agree.
- [ ] `npm ci` succeeds from a clean checkout.
- [ ] `npm run release:verify -- --report .model-artifacts/reports/release/YYYY-MM-DD_HHMM-<version>.md` passes and records Pi/Node versions plus every check.
- [ ] `catalog/pi-native-capabilities.json` and `catalog/gentic-inventory.json` are current.
- [ ] Core/full profile paths pass inventory validation.
- [ ] A temporary project scaffolds and smoke-loads one representative capability.
- [ ] Local Git install and `/reload` work using only `CONTRIBUTING.md`.
- [ ] CI and the Node compatibility workflow pass.
- [ ] Version follows the policy above; Git tag is signed and matches `package.json`.
- [ ] No npm publish is attempted while `private: true`.

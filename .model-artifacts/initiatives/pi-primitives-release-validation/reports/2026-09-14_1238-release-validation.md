# Pi primitives release validation

## Live runtime

- Real isolated Pi 0.84.2 TUI startup loaded `pi-primitives`, showed `4 registered`, and emitted no primitive warning.
- Live `/reload` completed and retained exactly `4 registered`.
- Actual `/scaffold primitive live-check --apply` created `index.ts`, `injection.md`, and `triggers.json` and displayed the explicit-registry next step.
- After temporary explicit registration, isolated typecheck/runtime assertions passed, matching prompts injected the generated policy without copying trigger content, unrelated prompts skipped it, and live reload retained `5 registered`.
- Both isolated HOME/project trees and all live processes were removed.

## Fuzzing and mutation

- Added deterministic property-style coverage for 2000 recursive/cyclic/accessor/proxy values plus configuration, trigger, path, symlink, diagnostic, and exact-boundary cases.
- Added isolated mutation testing; all 11 selected critical mutants are killed.
- Mutation analysis tightened exact property-budget and duplicate-config assertions.

## Independent review

A separate Codex CLI session performed a read-only trust-boundary review. Confirmed findings were reproduced and fixed:

- independent input fields no longer suppress each other or leak accessor exceptions;
- numeric scaffold names can no longer render invalid TypeScript identifiers;
- dangling symlinks no longer bypass `ctx.path()` validation;
- regex path work is bounded by candidate count/length.

The original bundled path regex consumed roughly 2446 ms CPU for five 16 KiB adversarial segmented inputs; the bounded regression now completes in roughly 1 ms. The review also confirmed ordinary external symlinks and traversal are rejected, explicit registration is intentional, and Pi reload uses a fresh runner rather than duplicating hooks.

Residual risks are documented in the independent-review finding: trusted hand-edited regex resources can still be pathological, policy headings are guidance rather than authorization, and local concurrent filesystem actors can race path-string APIs. None crosses an untrusted boundary under the package trust model.

## Final state

Final static checks found no scoped markers, temporary artifacts, diff whitespace errors, resource symlinks, registry drift, or adversarial bundled-regex budget failure. All planned repository verification commands are run after this report is written and recorded in `workflow.json`.
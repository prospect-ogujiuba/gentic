# Independent trust-boundary review

Reviewer: separate Codex CLI session (`gpt-5.6-sol`, high reasoning), instructed read-only. It inspected the uncommitted diff, runtime source, Pi loader/type definitions, scaffold output, resources, and tests; ran safe local reproductions; and exited without source edits.

## Confirmed findings and disposition

1. **High robustness: optional input could suppress or crash matching.** The reviewer reproduced `prompt: "write a report"` becoming false when paired with an oversized context file, and a throwing `systemPromptOptions.contextFiles` getter escaping `matchesPrimitivePrompt`. Fixed by evaluating the four fixed fields independently with per-field fail-closed reads. Regression: `independent trigger fields cannot suppress each other`.
2. **Medium correctness: numeric scaffold names generated invalid TypeScript identifiers.** `createScaffoldPreview("primitive", "123")` rendered `export default function 123Primitive`; TypeScript parsing failed. Fixed by requiring all scaffold names to start with a letter. Regression added to scaffold validation.
3. **Medium containment: dangling symlinks bypassed `ctx.path()` validation.** `existsSync` treated a dangling symlink as absent, validated only its contained parent, and returned the unchecked symlink path. Reproduced locally and fixed by walking with `lstatSync` and rejecting entries that cannot be canonically resolved. Existing external symlinks and lexical traversal remain rejected; regression now covers dangling symlinks.
4. **Performance/availability: regex work required a stronger bound.** Separate local measurement found the bundled implementation-file pattern consumed about 2446 ms CPU across five 16 KiB segmented non-matches. Fixed by independently bounding regex path evaluation to 1024 whitespace-delimited candidates of at most 512 characters; the same regression now takes about 1 ms. Trigger definition count/length bounds remain in place.

## Defense-in-depth observations and accepted assumptions

- An edited trusted trigger resource can still contain a pathological expression such as `(a+)+$`; the reviewer measured rapidly increasing cost by 24 characters. Trigger resources execute with the same package trust as TypeScript extension code, and bundled/scaffolded patterns are controlled and tested. Residual regex syntax is therefore documented as trusted package input rather than treated as an untrusted runtime boundary.
- Exact policy-heading duplication can be intentionally spoofed by custom system-prompt text. These policies are agent guidance, not authorization controls; exact-line idempotence is retained to prevent duplicate injection.
- Invalid config falls back to defaults, so a malformed `{ enabled: false, ... }` does not partially apply. This is the documented atomic-config behavior and does not enable tools or permissions; visible diagnostics make the failure actionable.
- Primitive names and failure counts are not bounded for custom programmatic definitions. Such initializers already hold the full `ExtensionAPI` and can directly call UI or filesystem APIs; the bundled explicit registry is fixed at four validated names.
- `readText` resolution/open and scaffold check/write retain local filesystem TOCTOU windows. Exploitation requires a concurrent actor with write access to trusted extension/project directories. Node's path-string APIs cannot provide portable `openat`-style ancestry guarantees; this remains residual local risk.

## Rejected false positives

- `..local.txt` is a contained filename, not traversal, and remains accepted.
- Existing symlinks outside the primitive directory are rejected by `readText`; dangling symlinks are now also rejected by `ctx.path`.
- A scaffolded directory is intentionally inert until imported into `EXPLICIT_PRIMITIVES`; live apply output states this step.
- Pi's loader uses a fresh module cache/runner on reload. The reviewer found no loader evidence of duplicate hooks, matching the observed live TUI reload status.
# pi-primitives

Fixed compatibility bundle for three explicit Pi prompt policies. This is not a plugin host: Pi owns extension discovery, loading, and package filters. The public `extensions/pi-primitives/index.ts` path remains unchanged; a physical rename is deferred to a major release.

Each built-in policy owns a native `before_agent_start` hook and reads its fixed bundled injection file. New reusable behavior belongs in native extensions, skills, or prompts.

## Anatomy

- **Mode:** `runtime`
- **Public entry:** `index.ts`
- **Layers:** none; three explicit policy hooks, without a registry.
- **Resources:** `primitives/`
- **Machine declaration:** optional handwritten `extension.anatomy.json` (not currently present)
- **Reference role:** fixed policy bundle; no `src/*` layering is needed.
- **Mismatch notes:** the historic directory name is retained for filter and scaffold compatibility.

## Included primitives

- `concise-output`: always-on system prompt guidance that keeps agent output short and file-oriented.
- `implementation-file-completion`: stable machine-state completion for canonical contracts, with `[COMPLETE]` markers limited to legacy/non-canonical files during migration.
- `model-artifacts`: conditional guidance for durable generated artifacts under `.model-artifacts/`.

## Startup and recovery

Startup calls concise-output, implementation-file-completion, and model-artifacts directly in that order. There is no directory scanning, dynamic loading, definition registry, generic initialization wrapper, resource context factory, or runtime trigger-file loader. Adding a folder does not execute code. `registerPrimitives` is retained as a fixed-bundle entrypoint accepting only `configPath`, not custom definitions. Migrate custom registrations to native extension entrypoints and native Pi resource settings.

The `pi-primitives` status reports registered/disabled/failed counts; warnings identify each failed initializer by name and a single-line diagnostic bounded to 512 characters. Global disablement reports every explicit entry as disabled. Fix the named resource or disable the primitive in `config.json`, then restart. Config must not exceed 16384 bytes and must be a JSON object; `enabled` must be boolean and `disabled` must be a duplicate-free array of known kebab-case primitive names. Unknown disabled names produce a visible config diagnostic while valid entries continue to apply. Invalid config reports a `config` failure and falls back to defaults. Static import failures require fixing the installation; config disablement cannot bypass module resolution. Unknown config fields also produce bounded migration diagnostics. Each built-in initializer is independently guarded; restart after repairing an installation rather than retrying registration in place.

For deployment or rollback, use a coherent package revision and restart an idle session. Do not restore the old discovery loader alongside these hooks, which would duplicate injections.

## Working indicator migration

Pi's native working indicator replaces the random whimsical messages. `whimsical` remains a no-op compatibility entry: its enabled/disabled config name and registration report behavior are preserved, but it installs no turn hooks and never overrides or resets UI messages. No user data migration is needed.

Startup emits an informational deprecation notice when `whimsical` is enabled. Add it to `disabled` to silence the notice. Restart an idle Pi session after upgrading so no old callback remains. Roll back only with a coherent package revision, not by restoring an individual module.

## Retained scaffold compatibility

`/scaffold primitive <name>` still creates `index.ts`, `injection.md`, and `triggers.json` at the same paths. Its generated entrypoint now loads directly through native Pi extension settings or `--extension`, without a bundle registry edit. No scaffold command or public path is removed.

`PrimitiveContext`, `loadPromptPolicy`, and `loadPrimitiveTriggers` remain source-compatibility adapters for previously generated code; no runtime context is constructed by this bundle. The scaffold uses explicit resource reads and a compatibility parser. The generic trigger parser remains solely for this retained scaffold surface. Built-in policies use fixed predicates in their own entrypoints; the old bundled trigger JSON files are characterization fixtures, not runtime configuration.

`config.json` still controls only the fixed built-in bundle. Use native Pi settings for custom extensions. Native package profiles and filters are unchanged.

## Prompt policy bounds

Policies use a statically imported helper; no dynamic loading is needed for injection. Each bundled policy is limited to 8192 characters (plus two separator newlines) and is skipped if its first heading already exists as an exact line in the system prompt. Oversized policy resources fail registration with the normal primitive diagnostic.

Conditional matching considers only the user prompt, custom prompt, appended system prompt, and structured context files. Each trigger field is limited to 64 entries of at most 512 characters. Each of the four fixed input fields has an independent 32768-character phrase scan, so malformed optional context cannot suppress a valid user-prompt trigger. Regex path matching additionally accepts at most 1024 whitespace-delimited candidates of at most 512 characters each; an over-limit path set skips regex matching rather than evaluating partial input. Per-field recursive flattening is limited to 1024 visited values, 1024 enumerated property names, and depth 16. Oversized, cyclic, own-accessor-bearing, or unreadable fields fail closed independently rather than matching a truncated prefix. Blank entries and regexes that match empty input fail registration instead of making a conditional policy always-on. Trigger content is never copied into the injected policy. Limits count JavaScript UTF-16 code units, not tokens. Trigger JSON and regexes are trusted bundled resources, not user-supplied executable configuration.

Keep prompt templates and skills focused on their workflows; use native extensions for shared executable behavior, not a replacement primitive framework.

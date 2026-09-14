# pi-primitives

Central extension for Gentic lightweight primitives.

Primitives are retained as self-contained runtime modules under `primitives/`. Each primitive owns an `index.ts` entrypoint and may carry supporting markdown, scripts, config, or helper files beside it.

Use primitives only for small, reusable Pi runtime building blocks that apply across prompts and skills but do not warrant a native command, tool, event, or package resource. New product plugins must use a native extension template.

## Anatomy

- **Mode:** `runtime`
- **Public entry:** `index.ts`
- **Layers:** none; this intentionally remains a shallow explicit registry.
- **Resources:** `primitives/`
- **Machine declaration:** optional handwritten `extension.anatomy.json` (not currently present)
- **Reference role:** runtime primitive hub; no `src/*` layer folders are needed while registration stays shallow.
- **Mismatch notes:** none; the inferred runtime anatomy matches the explicit `index.ts` registry and colocated `primitives/` resources.

## Included primitives

- `concise-output`: always-on system prompt guidance that keeps agent output short and file-oriented.
- `implementation-file-completion`: stable machine-state completion for canonical contracts, with `[COMPLETE]` markers limited to legacy/non-canonical files during migration.
- `model-artifacts`: conditional guidance for durable generated artifacts under `.model-artifacts/`.

## Startup and recovery

Startup uses only the explicit registry: directory scanning, cache-busting imports, and the former `loadPrimitives` helper are removed. Adding a folder alone no longer registers code. Local callers of the old helper must migrate to `registerPrimitives` with explicit definitions; there is no `primitivesDir` discovery option.

The `pi-primitives` status reports registered/disabled/failed counts; warnings identify each failed initializer by name and a single-line diagnostic bounded to 512 characters. Global disablement reports every explicit entry as disabled. Fix the named resource or disable the primitive in `config.json`, then restart. Config must not exceed 16384 bytes and must be a JSON object; `enabled` must be boolean and `disabled` must be a duplicate-free array of known kebab-case primitive names. Unknown disabled names produce a visible config diagnostic while valid entries continue to apply. Invalid config reports a `config` failure and falls back to defaults. Static import failures require fixing the installation; config disablement cannot bypass module resolution. Initialization is not transactional: a failing custom primitive may have registered hooks before throwing, so restart after repair rather than retrying it in place.

For deployment or rollback, use a coherent package revision and restart an idle session. Do not restore the old discovery loader alongside explicit registration, which would duplicate hooks.

## Working indicator migration

Pi's native working indicator replaces the random whimsical messages. `whimsical` remains a no-op compatibility entry: its enabled/disabled config name and registration report behavior are preserved, but it installs no turn hooks and never overrides or resets UI messages. No user data migration is needed.

Restart an idle Pi session after upgrading so no previously registered callback or working-message override remains. To roll back, restore the prior `primitives/whimsical/index.ts` from the previous revision and restart again; do not run both implementations alongside each other.

## Add a primitive

1. Create `primitives/<name>/index.ts`.
2. Export a default function with this shape:

   ```ts
   import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
   import type { PrimitiveContext } from "../../index.ts";

   export default function primitive(pi: ExtensionAPI, ctx: PrimitiveContext): void {
     // register hooks, commands, tools, or other lightweight behavior
   }
   ```

3. Put supporting files inside the same primitive directory.
4. Keep always-on prompt injection conditional when possible, using primitive-local trigger/config files instead of coupling to another extension.
5. Use `ctx.readText("file.md")` to read primitive-local text files, or `ctx.path("file")` when a primitive needs a containment-checked local path. Both reject lexical and symlink escapes from the primitive directory.
6. Import the module in the explicit `EXPLICIT_PRIMITIVES` registry in `index.ts`; registry order is registration order.
7. Run `/reload` in pi.

`config.json` controls global enablement and disabled primitive names. Each imported primitive registers in isolation: initialization failures such as invalid JSON or trigger regexes are reported in the `pi-primitives` session status without preventing later modules from registering. Static module-resolution failures remain startup errors. Shared trigger handling precompiles regexes and recursively flattens structured context files.

## Prompt policy bounds

Policies use a statically imported helper; no dynamic loading is needed for injection. Each bundled policy is limited to 8192 characters (plus two separator newlines) and is skipped if its first heading already exists as an exact line in the system prompt. Oversized policy resources fail registration with the normal primitive diagnostic.

Conditional matching considers only the user prompt, custom prompt, appended system prompt, and structured context files. Each trigger field is limited to 64 entries of at most 512 characters. Each of the four fixed input fields has an independent 32768-character phrase scan, so malformed optional context cannot suppress a valid user-prompt trigger. Regex path matching additionally accepts at most 1024 whitespace-delimited candidates of at most 512 characters each; an over-limit path set skips regex matching rather than evaluating partial input. Per-field recursive flattening is limited to 1024 visited values, 1024 enumerated property names, and depth 16. Oversized, cyclic, own-accessor-bearing, or unreadable fields fail closed independently rather than matching a truncated prefix. Blank entries and regexes that match empty input fail registration instead of making a conditional policy always-on. Trigger content is never copied into the injected policy. Limits count JavaScript UTF-16 code units, not tokens. Trigger JSON and regexes are trusted bundled resources, not user-supplied executable configuration.

Keep prompt templates and skills focused on their local workflow; use primitives for shared runtime behavior instead of duplicating it.

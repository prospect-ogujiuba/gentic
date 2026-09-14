# Retained primitive outcomes inventory

## Diagnosis

The extension currently combines two distinct concerns:

1. **Useful outcomes:** three prompt policies and lightweight working feedback.
2. **Loader mechanics:** directory discovery, config filtering, cache-busted dynamic imports, primitive-local file access, failure aggregation, and startup status reporting.

The useful policy outcomes do not depend conceptually on directory scanning or dynamic import. The loader supplies discovery and isolation, while each retained policy only needs explicit registration plus access to its static injection/trigger data. `whimsical` is presentation-only and is not listed among the README's included primitives.

## Outcome and test inventory

| Primitive | Current outcome | Activation and bounds | Current tests |
| --- | --- | --- | --- |
| `concise-output` | Appends the reusable `Output and Responses Efficiency Policy` to the system prompt. | Every `before_agent_start`; skips an empty injection and skips when the policy heading already exists. The appended text is the fixed local `injection.md`. | `concise-output primitive injects reusable output policy`; `concise-output primitive skips duplicate policy`; indirectly present in the unrelated-prompt test. |
| `implementation-file-completion` | Adds the completion convention: canonical contracts use machine state and stable names; `[COMPLETE]` remains limited to fully complete legacy/non-canonical files. | `before_agent_start` only when a case-insensitive phrase substring or path regex matches the prompt, custom prompt, appended system prompt, or recursively flattened context files. The appended text is fixed local content; no duplicate-heading guard exists. | `implementation-file-completion primitive matches expanded user prompt`; `implementation-file-completion primitive skips unrelated prompts`; shared structured-context matching is covered by the trigger test. |
| `model-artifacts` | Adds layout-v2 placement, naming, authority, migration-conflict, and generated-plan guidance. | Same conditional trigger pipeline as implementation completion. The appended text is fixed local content; no duplicate-heading guard exists. | `model-artifacts primitive injects reusable artifact convention`; `layout-v2 fixture declares namespaces, compatibility, safety, and source-of-truth cases`; `primitive triggers flatten structured context files`. |
| `whimsical` | Replaces the UI working message with one random whimsical string at turn start and clears it at turn end. | Every turn; `Math.random()` selects from 454 inline strings. It does not affect prompts or model behavior. | No current test directly covers message selection, event registration, or reset. |

The retained useful outcomes are the three documented prompt policies. Whimsical feedback is a separable optional UI outcome suitable for a small data resource or the native working indicator.

## Dynamic-loading characterization

`extensions/pi-primitives/index.ts` currently:

- reads optional `config.json`; malformed config becomes a `config` failure and loading continues with defaults;
- returns without loading when the primitive directory is absent or `enabled` is `false`;
- scans immediate non-hidden subdirectories, sorts names alphabetically, and records configured names as skipped;
- looks for `<primitive>/index.ts` and dynamically imports it with a `?gentic=<timestamp>-<name>` cache-busting query;
- requires a default function export, awaits registration, and catches each primitive's import/initialization failure so later primitives still load;
- provides primitive-local `path` and `readText` helpers, rejecting paths that escape the primitive directory;
- publishes loaded/skipped/failed counts on `session_start` and warns with per-primitive failures.

Loader tests cover isolation across invalid import, JSON, and regex failures; alphabetical continuation to a later valid primitive; and configured disabling without failure. They do not directly assert directory absence, global disablement, missing entrypoints, path-escape rejection, cache busting, or the `session_start` status/notification text.

## Prompt-injection characterization

- Shared trigger JSON accepts optional string arrays `phrases` and `pathPatterns`; regexes are precompiled case-insensitively and invalid field types/regexes throw during primitive registration.
- Matching recursively flattens strings, numbers, booleans, arrays, and object values, then uses case-insensitive phrase substring matching or regex matching.
- Conditional primitives inspect only `event.prompt`, `customPrompt`, `appendSystemPrompt`, and `contextFiles`.
- Each successful hook returns the prior system prompt plus two newlines and fixed local markdown. Injection size is therefore fixed per match, but structured trigger input traversal is not explicitly size/depth bounded and conditional policies do not prevent duplicate injection.
- Handler ordering currently follows alphabetical primitive directory order, and the test pipeline composes returned system prompts in registration order.

## Whimsical runtime characterization

`whimsical` embeds 454 messages directly in executable TypeScript. On `turn_start`, it chooses one uniformly by `Math.floor(Math.random() * messages.length)` and calls `ctx.ui.setWorkingMessage(message)`. On `turn_end`, it calls `ctx.ui.setWorkingMessage()` to restore the default. There is no timer or background process, but the large inline catalog, random selection, and two event hooks are machinery for a cosmetic outcome and currently have no regression test.

## Current test command

`npm run test:primitives` runs `node --experimental-strip-types --test test/pi-primitives.test.ts` and is the objective characterization check for this inventory.

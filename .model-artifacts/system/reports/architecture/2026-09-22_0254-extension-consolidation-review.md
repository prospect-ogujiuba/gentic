# Gentic extension consolidation review

## Scope and method

This review covers the first-party extensions discovered from `package.json#pi.extensions = ["./extensions"]`, their READMEs and TypeScript source, package-level shared modules, Pi's extension/package/TUI guidance, and the live `gentic_catalog` status. It is a structural review, not a behavioral test run.

The live runtime reports one Gentic package extension source plus integrations owned by `extension:index` and npm packages including `context-mode`, `pi-autoresearch`, `pi-context-pruning`, `pi-interactive-shell`, `pi-intercom`, `pi-mcp-adapter`, `pi-messenger`, `pi-web-access`, and `@gotgenes/pi-permission-system`. Those third-party implementations are out of scope; the detailed findings below concern the nine first-party extension folders.

## Current first-party extension map

| Extension | Primary ownership | Public/runtime surface | State or persistence | Key dependencies |
|---|---|---|---|---|
| `pi-artifacts` | Safe creation of canonical generated Markdown | `artifact` tool | `.model-artifacts/**`; exclusive atomic publication | Standalone layered service |
| `pi-catalog` | Runtime discovery of Pi commands and tools | `/catalog`; `gentic_catalog` | No runtime catalog state; build-time capability fixture | Native `pi.getCommands()` / `pi.getAllTools()` |
| `pi-commands` | Suite-level slash commands and scaffolding | `/clear`; `/scaffold` | Transactional scaffold writes | Templates currently stored under `pi-catalog` |
| `pi-context` | Bounded, content-safe context usage snapshots and pressure notifications | `/pi-context` | Optional Markdown/JSON reports; config in global/project Pi locations | Native context APIs; exports HUD adapter |
| `pi-git` | Deterministic bounded Git repository snapshot | `git_snapshot`; `/pi-git` | None; read-only Git subprocesses | Bounded process runner in its app layer |
| `pi-hud` | Optional compact runtime widget | `/pi-hud`; widget `pi-hud` | Session/UI state and display config | Deep imports from `pi-git` and `pi-context` internals |
| `pi-primitives` | Small prompt-policy host | Session status plus `before_agent_start` injections | `config.json` enable/disable registry | Explicit registry of `concise-output`, `implementation-file-completion`, `model-artifacts`, and no-op `whimsical` |
| `pi-swe` | Durable assessed initiative workflow authority | `swe` tool; `/swe`; docket/modal | Canonical `workflow.json`, locks, revisions, evidence | Shared lifecycle coordination probe |
| `pi-todo` | Lightweight branch-local focus list | `todo` tool; `/todo`; docket/modal | Session custom events | Shared lifecycle coordination probe |

## Executive assessment

The suite's product boundaries are mostly sound. The main problem is not too many public extensions; it is **implementation reuse crossing extension boundaries in ad hoc ways**. Three clusters deserve consolidation:

1. `pi-hud` consumes `pi-context` and `pi-git` through deep relative imports.
2. `pi-swe` and `pi-todo` duplicate a substantial presentation framework.
3. Artifact filesystem rules and scaffold ownership are split across nominal owners.

A fourth issue is conceptual: `pi-primitives` has become a nested extension/plugin framework with its own registry and enable/disable configuration, despite Gentic's stated preference for native Pi discovery and package filters.

## Findings and recommendations

### 1. Replace extension-to-extension deep imports with package-internal service contracts — high priority

`pi-hud` imports:

- `pi-git/src/app/snapshot.ts`;
- `pi-context/src/app/index.ts`;
- `pi-context/src/domain/index.ts`;
- `pi-context/src/config/index.ts`.

This makes private folder layout an accidental API. It also leaves HUD with context normalization/formatting helpers that overlap `pi-context` (`nonNegativeNumber`, `positiveNumber`, `percentNumber`, and `formatPercent`). Git remains correctly owned by `pi-git`, but its process runner is effectively a shared infrastructure service.

**Restructure:**

- Extract a stable package-internal `src/services/git-snapshot/` contract and implementation. Let `pi-git` own Pi registration/rendering while both `pi-git` and `pi-hud` consume the service.
- Extract a stable `src/services/context-snapshot/` DTO/facade that returns the bounded HUD projection. Let `pi-context` own pressure policy, reporting, and notifications; let HUD consume only the facade.
- Add an anatomy/dependency check: extensions may import package-level contracts, but never another extension's `src/**` internals.

Do **not** merge HUD, Git, and context into one extension. Their public responsibilities differ; only the reusable implementation seam should move.

### 2. Consolidate the SWE/Todo presentation layer, not their lifecycle authorities — high priority

`pi-swe/src/ui` and `pi-todo/src/ui` contain parallel `docket.ts`, `format.ts`, `modal.ts`, and `theme.ts` modules. Token-set comparison found:

- `format.ts`: 1.00 similarity;
- `modal.ts`: 0.76;
- `theme.ts`: 0.67;
- `docket.ts`: 0.39.

Both implement status chips, colors, ANSI padding, left/right layout, frames, responsive keyboard modals, and docket presentation. This duplication will drift as TUI behavior changes.

**Restructure:** create `src/ui/docket-kit/` with pure, domain-neutral primitives:

- ANSI-aware clipping/padding and framed rows;
- shared theme tokens and status-chip rendering;
- modal viewport, filtering, scrolling, and keyboard mechanics;
- a small adapter interface for rows, details, progress, and actions.

Keep `pi-swe` and `pi-todo` separate. Their apparent product overlap is intentional and well bounded:

- SWE is durable repository authority with evidence-gated transitions.
- Todo is lightweight session-branch state.
- The lifecycle probe prevents dual ownership.

Merging their state machines would recreate the orchestration complexity that `pi-todo` deliberately removed.

### 3. Make `pi-artifacts` the reusable artifact publication backend — high priority

`pi-artifacts` owns canonical placement, path normalization, symlink checks, exclusive creation, atomic rename, and hashing. However, `pi-context/src/app/native-export.ts` independently creates `.model-artifacts/system/reports/pi-context/` output with its own `mkdir`/`writeFile` and safety rules. `pi-swe` separately validates initiative artifact references, while `pi-primitives/model-artifacts` injects guidance describing the same conventions.

These are distinct product surfaces but one filesystem contract.

**Restructure:**

- Move artifact normalization/publication into `src/services/artifact-store/`.
- Keep the `artifact` tool adapter in `pi-artifacts`.
- Have `pi-context` call the shared store for Markdown reports; add a typed JSON/report publication variant only if JSON remains a supported canonical output.
- Keep `workflow.json`, SWE locking, and revision authority entirely in `pi-swe`; never route workflow authority through the generic artifact writer.
- Generate or test the `model-artifacts` prompt policy against the same constants/schema to prevent documentation drift.

This consolidates safety logic without confusing content artifacts with workflow authority.

### 4. Move scaffolding templates out of `pi-catalog` — medium-high priority

`/scaffold` is implemented by `pi-commands/commands/scaffold.ts`, but all extension/tool/command/event/UI/resource templates live under `pi-catalog/templates/`. The command therefore owns behavior while the catalog owns its filesystem inputs. `pi-catalog`'s declared role is runtime discovery, not code generation.

**Restructure:** choose one of:

1. Move templates to `pi-commands/templates/` because `/scaffold` is their only runtime consumer; or
2. Create package-level `scaffolding/templates/` plus `src/scaffolding/` if generation scripts and CI also need them.

Keep `pi-catalog` focused on discovery and search. Keep `/scaffold` in `pi-commands`; merging both extensions is unnecessary.

### 5. Recast `pi-primitives` as a policy bundle or dissolve it into native extensions — medium priority

`pi-primitives` maintains an explicit internal registry, custom config enablement, isolated initialization reporting, trigger parsing, and a primitive scaffold path. This is a plugin framework inside the Pi extension framework. It sits awkwardly beside the repository rule that Pi owns discovery and Gentic does not maintain its own enable/disable registry.

Current contents do not justify a general sub-framework:

- three prompt-policy injections;
- one no-op compatibility entry (`whimsical`).

**Recommended direction:**

- Rename/reframe it as `pi-policies` if the three policies need shared conditional-injection mechanics.
- Remove the generic primitive creation path from `/scaffold`; new product behavior should use native Pi extensions, skills, or prompts.
- Time-box and then delete the no-op `whimsical` compatibility entry.
- Prefer Pi package filters for coarse enablement. Retain a small policy config only where per-policy runtime selection is genuinely needed.

This reduces conceptual surface without forcing three tiny policy extensions prematurely.

### 6. Tighten shared-module governance — medium priority

The repository already has good package-level precedents: `src/lifecycle-coordination.ts`, `src/pi-contract.ts`, resource validation, and release inventory. Expand that pattern deliberately rather than creating a broad `utils.ts`.

Recommended dependency direction:

```text
extensions/*/index.ts and src/pi/*
        ↓
extension app/domain/UI adapters
        ↓
src/contracts/* and src/services/*
        ↓
Node/Pi APIs
```

Rules:

- no `extensions/A/** -> extensions/B/src/**` imports;
- shared services expose bounded typed contracts and no Pi registration side effects;
- extension entrypoints remain the sole owners of commands/tools/events/widgets;
- domain authorities remain explicit (`workflow.json` only SWE, generic artifacts only artifact store, session todo events only Todo);
- every extracted service gets contract tests used by each adapter.

## What should remain separate

| Pair/cluster | Decision | Reason |
|---|---|---|
| `pi-swe` / `pi-todo` | Keep separate; share UI only | Different durability, rigor, state, and authority |
| `pi-artifacts` / `pi-swe` | Keep separate; share canonical path validation where safe | Generic files must never become workflow authority |
| `pi-context` / `pi-hud` | Keep separate; expose one stable snapshot contract | Measurement/policy differs from presentation |
| `pi-git` / `pi-hud` | Keep separate; share bounded snapshot service | Git snapshot is reusable beyond UI |
| `pi-catalog` / `pi-commands` | Keep separate; relocate templates | Discovery differs from mutation/scaffolding |
| Tool and slash-command twins within one extension | Keep | They are two adapters over one service, not duplicated products |

## Proposed target layout

```text
src/
  contracts/
    context-snapshot.ts
    git-snapshot.ts
    artifact.ts
  services/
    artifact-store/
    context-snapshot/
    git-snapshot/
  ui/
    docket-kit/
  lifecycle-coordination.ts

extensions/
  pi-artifacts/   # tool adapter
  pi-catalog/     # discovery only
  pi-commands/    # slash commands + scaffold ownership
  pi-context/     # context policy/reporting adapter
  pi-git/         # git tool/command adapter
  pi-hud/         # widget adapter
  pi-policies/    # narrow conditional policy bundle
  pi-swe/         # durable workflow authority
  pi-todo/        # branch-local focus authority
```

The exact folder names matter less than enforcing stable shared contracts and one-way dependencies.

## Migration sequence

1. **Add dependency enforcement first.** Detect extension-to-extension deep imports in `check:anatomy` or a new architecture check.
2. **Extract context and Git contracts/services.** Migrate HUD, then delete compatibility deep imports and duplicated numeric formatting.
3. **Extract `docket-kit`.** Start with identical `format.ts`, then theme/modal mechanics, leaving domain-specific docket adapters last.
4. **Extract artifact store.** Migrate `pi-artifacts`, then `pi-context`; add parity tests for path, symlink, collision, and atomic-write behavior.
5. **Relocate scaffold templates.** Update tests and resource validation; keep generated output byte-stable.
6. **Narrow primitives to policies.** Deprecate primitive scaffolding and `whimsical`, document rollback, then rename only after package filters and tests are updated.

Each step can ship independently and should preserve current public tool/command names.

## Expected payoff

- Fewer accidental private APIs and safer extension refactors.
- One implementation of Git bounds, context projection, artifact publication, and TUI mechanics.
- Clearer ownership: extensions register surfaces; package-level services provide reusable behavior.
- Reduced drift between `pi-swe` and `pi-todo` UI.
- A simpler contributor model aligned with native Pi extension discovery.

## Caveats

- Source line and similarity measures are directional indicators, not reasons to merge domain models.
- Third-party runtime extensions were inventoried by owner only and were not source-audited.
- No code was changed and no test suite was run for this report.
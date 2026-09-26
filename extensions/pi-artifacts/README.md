# pi-artifacts

pi-artifacts creates durable model-generated Markdown files in Gentic's canonical `.model-artifacts` layout. It owns safe placement and file creation only; workflow authority remains with pi-swe.

## Surface

The `artifact` tool accepts:

- `scope`: `initiative` or `system`
- `topic`: required for initiative scope
- `kind`: `specs`, `plans`, `todo`, `findings`, `reports`, or `logs`; system scope permits only `reports` and `logs`
- `namespace`: optional kebab-case grouping for system artifacts
- `name`: kebab-case short name
- `content`: non-empty Markdown, bounded to 1 MiB

Initiative output:

```text
.model-artifacts/initiatives/<topic>/<kind>/YYYY-MM-DD_HHMM-<name>.md
```

System output:

```text
.model-artifacts/system/<logs|reports>/[namespace]/YYYY-MM-DD_HHMM-<name>.md
```

## Safety and ownership

Paths are normalized, project-relative, and restricted to canonical scopes and kinds. Topic, namespace, and name segments must be kebab-case. Creation rejects symlinked or replaced parents, traversal, invalid scope/kind combinations, empty or oversized content, and existing destinations. `src/services/safe-file-publication.ts` owns bounded staging, file sync, stable directory-descriptor publication, exclusive hard-link creation, destination verification, inode-aware cleanup, and directory sync. Publishing never overwrites another artifact and fails closed when the runtime cannot expose `/proc/self/fd` or `/dev/fd`.

The shared backend explicitly rejects every `workflow.json` destination. That authority remains solely with pi-swe's private `SweService`/store publication path; pi-artifacts supplies no bypass. Consumers may attach the returned artifact path and SHA-256 hash to their own durable state. The centralized adversarial matrix is documented in `docs/model-artifacts.md`.

## Anatomy

- `src/domain/types.ts`: public requests, results, scopes, and kinds
- `src/domain/normalize.ts`: canonical paths and timestamps
- `src/app/service.ts`: artifact validation, metadata, and shared-backend adapter
- `../../src/services/safe-file-publication.ts`: bounded, exclusive, atomic artifact/report publication
- `src/pi/register.ts`: the model-callable tool adapter

## Tests

```text
node --experimental-strip-types --test test/pi-artifacts.test.ts
npm run typecheck
npm run check:model-artifacts
```

# pi-git

`pi-git` provides deterministic git scope snapshots for commit, push, and handoff work.

## Anatomy

- **Mode:** `layered`
- **State:** `layered-lite`
- **Public entry:** `index.ts`
- **Layers:** `app`, `pi`, `ui`, `resources`
- **Resources:** `prompts/`
- **Machine declaration:** optional handwritten `extension.anatomy.json` (not currently present)
- **Reference role:** git utility layered-lite example; `index.ts` is the supported service and registration entrypoint.
- **Mismatch notes:** none known; collection orchestration lives in `src/app/snapshot.ts`, parsing in `src/app/parse.ts`, rendering in `src/ui/render.ts`, Pi registration in `src/pi/register.ts`, and prompt resources in `prompts/`.

## Orientation block

- **What it does:** captures a typed, bounded git root/branch/upstream snapshot with staged, unstaged, untracked, conflict, and remote groups. Each subprocess stream is retained only to 256 KiB; status/remote truncation is explicit, complete NUL/line records remain parseable, and public refs, paths, URLs, and errors have field limits. Git command failures remain typed errors and are never rendered as field values.
- **Commands/tools it registers:** `git_snapshot` model-callable tool and `/pi-git` command.
- **Pi events it listens to:** none.
- **State/config files it reads/writes:** spawns read-only `git` commands with cancellation and a ten-second timeout; writes no state files.
- **Internal module map:** `index.ts` exposes the supported registration-free collector and retains the default Pi adapter; `src/app/snapshot.ts` orchestrates collection; `src/app/parse.ts` parses and bounds Git output; `src/ui/render.ts` owns text presentation; `src/pi/register.ts` wires the tool and command; `prompts/` contains git workflow prompt resources.
- **Tests to run:** `node --experimental-strip-types --test test/pi-git.test.ts test/extension-dependency-boundaries.test.ts` or the full `npm test` suite.
- **Known boundaries/non-goals:** reports repository state only; it does not stage, commit, push, or mutate git state. Direct `spawn` is a deliberate exception to the usual `ExtensionAPI.exec` path because that API returns completed strings without a pre-capture byte ceiling; the shared bounded-process service instead inherits the process environment/cwd while bounding streams and process-group cleanup.

## Supported consumer boundary

Sibling production extensions may import `collectGitSnapshot` and the re-exported `GitSnapshot` contract from `extensions/pi-git/index.ts`. Code that needs only the data contract may import `src/contracts/git-snapshot.ts`. Bounded process execution is available from `src/services/bounded-process.ts` as `execBounded`, `MAX_CAPTURE_BYTES`, and `BoundedProcessResult`. These modules perform no Pi registration or UI work when imported.

`extensions/pi-git/src/**` is private implementation. Consumers must not import its collector, parser, renderer, or adapter modules. The production dependency guard (`npm run check:dependencies`) enforces that rule for sibling extension source.

The current pi-hud private imports are temporary exact, stale-detecting guard exceptions. Initiative `03-pi-hud-provider-decoupling` owns migration to the supported boundaries and removal of all exceptions; new exceptions or broadened entries are not permitted.

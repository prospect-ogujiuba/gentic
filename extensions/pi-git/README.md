# pi-git

`pi-git` provides deterministic git scope snapshots for commit, push, and handoff work.

## Anatomy

- **Mode:** `layered`
- **State:** `layered-lite`
- **Public entry:** `index.ts`
- **Layers:** `app`, `pi`, `resources`
- **Resources:** `prompts/`
- **Machine declaration:** optional handwritten `extension.anatomy.json` (not currently present)
- **Reference role:** git utility layered-lite example; `index.ts` stays a thin adapter.
- **Mismatch notes:** none known; snapshot collection/rendering lives in `src/app/snapshot.ts`, Pi registration lives in `src/pi/register.ts`, and prompt resources live in `prompts/`.

## Orientation block

- **What it does:** captures a typed, bounded git root/branch/upstream snapshot with staged, unstaged, untracked, conflict, and remote groups. Git command failures remain typed errors and are never rendered as field values.
- **Commands/tools it registers:** `git_snapshot` model-callable tool and `/pi-git` command.
- **Pi events it listens to:** none.
- **State/config files it reads/writes:** shells out to `git`; writes no state files.
- **Internal module map:** `index.ts` remains the extension entrypoint; `src/pi/register.ts` wires the tool and command; `src/app/snapshot.ts` collects and renders snapshot data; `prompts/` contains git workflow prompt resources.
- **Tests to run:** `node --experimental-strip-types --test test/pi-git.test.ts` or the full `npm test` suite.
- **Known boundaries/non-goals:** reports repository state only; it does not stage, commit, push, or mutate git state.

# gentic

`gentic` is the suite-orchestrator extension for the Gentic Pi package. It reports package/resource status and routes users to extension-owned commands, but it does not own the feature behavior implemented by sibling extensions.

## Orientation block

- **What it does:** summarizes top-level package resources, tracks the current session/resource discovery status, lists extension command owners, finds commands, and forwards `/gentic run ...` to the requested extension command.
- **Commands/tools it registers:** `gentic_status` model-callable tool; `/gentic` command with `status`, `commands`, `find <term>`, `run <command>`, and `reload`.
- **Pi events it listens to:** `session_start` records cwd/resource reason and sets the `gentic orchestrator` status; `resources_discover` updates resource-discovery status.
- **State/config files it reads/writes:** reads the top-level `package.json` for package name, version, and Pi resource declarations; keeps last-session status in memory; writes no suite-owned state files.
- **Internal module map:** `index.ts` contains package summary helpers, command-owner grouping, status text, the `gentic_status` tool, and the `/gentic` command router.
- **Tests to run:** `npm test -- test/gentic-demo.test.ts` or the full `npm test` suite.
- **Known boundaries/non-goals:** this extension is an orchestrator/index surface only; feature ownership stays with extensions such as `pi-gate`, `pi-todo`, `pi-swe`, `pi-catalog`, and others.

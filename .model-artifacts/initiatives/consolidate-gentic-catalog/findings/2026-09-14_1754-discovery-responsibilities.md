# Discovery responsibility characterization

## Useful outcomes to preserve

- `gentic_status` usefully reports the current cwd/resource-discovery reason, sorted extension command owners, and extension command count.
- `/gentic find <term>` searches live extension command names, descriptions, and canonical `sourceInfo.path`; it groups matches by owner and warns when no command matches.
- `gentic_catalog` and `/catalog` expose version-stamped, static package surfaces and Pi native capability groups.

## Overlap and boundaries

- **Duplicate routing:** `/gentic status`, `/gentic commands`, and `/gentic find` implement runtime discovery alongside the separate `/catalog` and `gentic_catalog` discovery surface.
- **Proxy invocation:** `/gentic run <command> [args]` does not invoke a command API. It forwards a slash command through `pi.sendUserMessage`; commands are already directly invokable by users.
- **Runtime metadata:** `extensions/gentic/src/pi/register.ts` queries `pi.getCommands()`. It does not yet include tools from `pi.getAllTools()`.
- **Diagnosed status defect:** the status code intends to show the top-level package resource summary, but its `ROOT` resolves to `extensions/`; current output is `gentic@unknown` and `no pi resources declared`. This broken outcome is not marked for preservation.
- **Generated fixture:** `scripts/generate-pi-catalog.ts` owns `catalog/pi-native-capabilities.json`. It validates pinned Pi declarations and writes/checks the deterministic build-time fixture from `src/pi-contract.ts`; runtime discovery should not regenerate it.
- **Static catalog presentation:** `extensions/pi-catalog/` formats the pinned contract and fixture-derived declarations. It does not discover currently registered commands or tools.

Characterization coverage is in `test/gentic-demo.test.ts`; pinned fixture ownership remains covered by `test/pi-catalog.test.ts`.

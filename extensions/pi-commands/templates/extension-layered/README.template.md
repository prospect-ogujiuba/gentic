# {{kebabName}}

**What it does:** {{description}}

**Commands/tools it registers:** {{registeredSurfaces}}

**Pi events it listens to:** {{eventNames}}

**State/config files it reads/writes:** {{stateAndConfig}}

**Internal module map:**

- `index.ts`: Pi-facing public entrypoint.
- `src/app/`: orchestration and use cases.
- `src/domain/`: durable types, policy, invariants, and reducers.
- `src/pi/`: Pi API adapters, session storage, and event wiring.
- `src/ui/`: rendering and user-facing text.

**Tests to run:** `{{verificationCommand}}`

**Known boundaries/non-goals:** {{boundaries}}

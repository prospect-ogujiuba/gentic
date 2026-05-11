# pi-swe

`pi-swe` is planned as a standalone Pi extension for software-engineering workflow guidance. Phase 01 only makes the extension discoverable and reserves its package surface; it does not enforce policy or emit warnings.

## Planned command namespace

`pi-swe` owns the `/swe` command namespace:

- `/swe status`
- `/swe config`

## Planned stage resources

Canonical stage prompts are expected to live under `extensions/pi-swe/prompts/` in later phases:

- `/swe-plan`
- `/swe-diagnose`
- `/swe-implement`
- `/swe-verify`
- `/swe-review`
- `/swe-finalize`
- `/swe-tdd`
- `/swe-dsa`

Matching skills are expected to live under `extensions/pi-swe/skills/<stage>/SKILL.md` in later phases.

## Cooperation boundary

`pi-swe` is standalone. It may cooperate with peers such as `pi-todo` or `pi-gate` only through explicit runtime capabilities, public tools/commands, or generic Pi APIs. It must not directly import peer extension internals or legacy workflow internals.

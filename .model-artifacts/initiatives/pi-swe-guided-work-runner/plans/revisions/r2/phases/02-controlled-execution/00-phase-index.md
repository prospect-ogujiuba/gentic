# P02: Controlled execution

- Kind: phase grouping node
- ID: `P02`
- Plan revision: 2
- Status: pending
- Depends on: `P01-C02`
- Topic: `pi-swe-guided-work-runner`

## Goal

Expose explicit operator controls and safely dispatch canonical stage skills across settled turns.

## Contracts

1. `P02-C01` command and checkpoint tool surface.
2. `P02-C02` settled-turn dispatcher and guarded completion.

## Verification

Focused command/event/tool tests, `npm run test:swe`, and `npm run typecheck`.

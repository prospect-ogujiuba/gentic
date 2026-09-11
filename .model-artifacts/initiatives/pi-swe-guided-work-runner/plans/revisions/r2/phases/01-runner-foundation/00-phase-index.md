# P01: Runner foundation

- Kind: phase grouping node
- ID: `P01`
- Plan revision: 2
- Status: pending
- Depends on: none
- Topic: `pi-swe-guided-work-runner`
- Active spec: r1

## Goal

Define deterministic runner policy, state, transitions, persistence, and structured checkpoints before Pi event-driven dispatch.

## Contracts

1. `P01-C01` runner domain and checkpoint protocol.
2. `P01-C02` versioned persistence and recovery.

## Verification

Focused lifecycle/runtime tests and `npm run typecheck`.

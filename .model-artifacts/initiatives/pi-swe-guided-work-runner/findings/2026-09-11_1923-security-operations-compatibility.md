# Security, migration, operations, and compatibility finding

- Topic: `pi-swe-guided-work-runner`
- Assessed spec: r1, `.model-artifacts/initiatives/pi-swe-guided-work-runner/specs/2026-09-11_1922-initiative-spec-r1.md`, `sha256:6f6322a43d11d32bd3b1d52d14633f728247b8b7dc042cde07039daf1bd5c0b0`
- Assessed draft plan: r1, `.model-artifacts/initiatives/pi-swe-guided-work-runner/plans/2026-09-11_1922-plan-index-r1.md`, `sha256:bb3817b3a3dcfcbb61cacbacf0f32a43f5c9a2d8794aff8bd320a2025f1052ea`
- Status: accepted for incorporation into plan r2

## Security

A self-prompting runner increases the impact of mistaken scope and unsafe tool use. Both modes must share hard stops for destructive/external actions, credential or network spend, deployment/publication, ambiguous identity, stale approval, path escape, symlink traversal, conflicting changes, and missing verifier/capability. `autonomous` is not an unrestricted mode; it only permits documented safe lifecycle continuation after explicit operator selection.

Follow-up prompts must be generated from fixed templates with bounded canonical fields, never concatenate artifact contents or assistant prose. The checkpoint tool accepts structured bounded values, normalizes project-relative POSIX paths, binds topic/plan/contract/stage/run/dispatch identity, and re-inspects hashes before accepting evidence. Tool descriptions must not imply that the model can approve plans or external effects.

## Migration

Add a separately versioned runner-state file. Absence means disabled; old config remains valid. Writers emit the new version only. Readers reject future versions and do not infer ownership from legacy session cursor fields. Rollback ignores/removes additive state and command/event wiring; canonical manifest/contracts/evidence stay valid. No automatic migration may turn existing `/swe orchestrate start|resume` into execution because that would violate its documented guidance-only contract.

## Operations

- Default: no active run, `guided`, `until=contract`, conservative turn/time/retry budgets.
- One active owner token and one pending dispatch per runtime/topic.
- Start/resume requires idle Pi state and an explicit command.
- Pause/stop is idempotent and checked before every dispatch and completion.
- Persist intent before `sendUserMessage`; acknowledge sent/settled/checkpoint states monotonically.
- On uncertain send outcome after crash, stop for operator recovery rather than risk duplicate work.
- Missing checkpoint, duplicate/contradictory event, completion recovery issue, or budget exhaustion emits a bounded durable handoff with exact remediation.
- Do not silently auto-reap ownership solely by TTL; status reports owner/run IDs needed for explicit recovery.
- Provider/tool cost limits are counters/policy gates, not estimates falsely presented as billing truth.

## Compatibility

Use documented Pi APIs: command handlers check `ctx.isIdle()`, `sendUserMessage` enables `expandPromptTemplates`, and continuation observes `agent_settled` rather than `agent_end` because retries/follow-ups may remain after `agent_end`. Never invoke skill expansion recursively while streaming. Inject the dispatcher for tests. Existing `/swe` parsing, completions, status/config/orchestrate/complete outputs, `swe_complete`, advisory/enforced modes, state reconstruction, and package resource declarations remain compatible.

The new command should be additive:

`/swe work <status|start|resume|pause|stop> [topic] [--mode guided|autonomous] [--until contract|initiative] [--max-turns N] [--max-minutes N]`

Exact final option names may be reduced during implementation only if the approved contract and docs are revised first; parser ambiguity must fail closed.

## Required plan incorporation

- Separate pure decision, persistence, command/tool, event dispatch, and qualification boundaries.
- Specify persist-before-send and settled/checkpoint sequencing.
- Treat material replanning and plan approval as guided human stops in both initial modes.
- Bind automatic completion to existing evidence/hash/claim/journal validation.
- Include security/path/bounds tests, crash recovery tests, API compatibility checks, and guidance-only regression tests.

## Residual risk

Pi provider/event behavior can vary across versions and model turns remain nondeterministic. Exact SDK API checks, fake-event tests, persisted tokens, canonical artifact validation, and bounded E2E qualification reduce but do not eliminate this risk. Initial release should be documented experimental and default to guided contract scope.

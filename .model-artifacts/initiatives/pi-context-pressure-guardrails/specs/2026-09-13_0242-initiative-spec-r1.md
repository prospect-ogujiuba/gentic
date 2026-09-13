# Initiative specification r1: Pi-context pressure guardrails

- Topic: `pi-context-pressure-guardrails`
- Revision: 1
- Status: active
- Created: 2026-09-13T02:42:25Z

## Problem

`pi-context` measures current context use and exposes reports/HUD snapshots, but it does not proactively classify pressure or notify operators when a long session approaches exhaustion. Users must remember to inspect `/pi-context`, so the most useful intervention can arrive too late.

## Outcome

Add deterministic, privacy-preserving context-pressure guardrails to `pi-context`: configurable warning and critical thresholds, transition-only notifications with hysteresis/cooldown, bounded state, and consistent report/HUD status. The feature advises only; it never compacts, interrupts, or dispatches work automatically.

## Users and observable behavior

- A user receives one warning when measured remaining context crosses the configured warning threshold.
- A user receives one critical notification when measured remaining context crosses the critical threshold.
- Repeated lifecycle samples in the same band do not spam notifications.
- Recovery above a hysteresis boundary rearms the corresponding transition.
- `/pi-context` and the existing HUD adapter expose the same pressure level and remaining percentage.
- Unknown or estimated-only usage never produces a false critical notification.
- Invalid project/global configuration emits bounded diagnostics and falls back safely.

## Constraints

- Preserve the existing no-raw-content privacy policy.
- Use `ctx.getContextUsage()` measurements only for proactive notifications.
- Keep hot-path work O(1), state bounded, and lifecycle cleanup idempotent.
- Project configuration overrides global configuration field-by-field.
- Defaults: warning at 25% remaining, critical at 10%, 5 percentage-point hysteresis, and a 5-minute repeat cooldown for changed diagnostic text only; level transitions themselves notify once.
- Existing `/pi-context` commands and report formats remain compatible through additive fields/lines.

## Non-goals

- Automatic compaction, summarization, prompt dispatch, model switching, or session termination.
- Persisting prompt/tool content or a cross-session pressure history.
- Replacing `pi-hud` rendering ownership.
- Predicting future token consumption.

## Acceptance criteria

- **AC-01:** A pure evaluator classifies exact measured usage as `normal`, `warning`, or `critical` using validated thresholds.
- **AC-02:** Hysteresis and prior-state tracking emit at most one notification per downward transition and rearm only after recovery.
- **AC-03:** Missing/unknown/estimated-only usage returns an unavailable/non-notifying result.
- **AC-04:** Project/global/default configuration merges deterministically; invalid values and inconsistent thresholds fall back with bounded diagnostics.
- **AC-05:** Pi lifecycle integration samples pressure without filesystem scans and emits correctly typed warning/critical UI notifications.
- **AC-06:** Session reset, shutdown, compaction, resume, and repeated hooks preserve bounded, idempotent state without stale notifications.
- **AC-07:** `/pi-context` summary/artifact/JSON and `createPiContextHudSnapshot()` expose consistent additive pressure data without raw content.
- **AC-08:** README and end-to-end documentation explain configuration, transitions, limitations, and operator response.
- **AC-09:** Focused pi-context tests, typecheck, package checks, and the full test suite pass.

## Compatibility

All command names and existing fields remain valid. New report/HUD fields are additive. Absence of configuration preserves current behavior plus safe default guardrails. Consumers that ignore the new HUD field remain unaffected.

## Migration and rollback

No persisted user data migration is required. Add a versioned config schema and ephemeral state only. Rollback removes pressure evaluation/config wiring and additive output fields; existing ledger/report behavior remains intact.

## Risks

- Notification spam from oscillating measurements.
- False urgency from estimated or unavailable usage.
- Threshold misconfiguration.
- Divergence between command and HUD pressure status.

## Open blockers

None.

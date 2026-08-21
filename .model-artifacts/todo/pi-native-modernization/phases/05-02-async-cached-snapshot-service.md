# Phase 5.2: Async cached snapshot service

Created: 2026-08-21
Purpose: Remove synchronous Git work from hot HUD paths while preserving bounded, current-enough status information.

## Goal

Provide a cancellable asynchronous snapshot service that keeps UI events responsive and cannot publish stale work after lifecycle changes.

## Scope

- Run `swe-dsa` first to define cache ownership, generation ordering, coalescing, debounce, cancellation, and stale-result rules.
- Replace `execFileSync` Git polling with cancellable asynchronous process execution.
- Cache the last good bounded snapshot and expose explicit loading, fresh, stale, unavailable, and error states.
- Coalesce concurrent refresh requests and debounce high-frequency signals.
- Associate work with a session generation so late completions cannot mutate reset state.
- Bound command duration, output, error detail, and retry behavior.

## Outputs

- Snapshot service contract and implementation.
- Async Git collector with cancellation and bounded results.
- Unit and integration tests for concurrency, cancellation, and stale completion.
- DSA finding under `.model-artifacts/findings/pi-native-modernization/`.

## Acceptance criteria

- No synchronous process runs in HUD event handlers or render paths.
- At most one refresh is active per service generation unless the DSA finding explicitly justifies otherwise.
- Concurrent requests share or coalesce work deterministically.
- Reset or shutdown aborts pending work and rejects late generation results.
- Errors preserve the last good snapshot without presenting failures as valid Git fields.
- Time and output bounds prevent a slow or noisy repository from degrading the TUI.

## Verification

- Slow-repository fixture proving timers and rendering remain responsive.
- Tests for coalescing, debounce, cancellation, timeout, non-repo, command failure, and oversized output.
- Deterministic stale-result test across generation reset.
- Open-handle check after service disposal.

## DSA decisions

See `.model-artifacts/findings/pi-native-modernization/2026-08-21_2048-async-snapshot-dsa-decision.md`.

- Use one process-local, single-slot cache for the active session workspace; no repository map or LRU.
- Use a monotonically increasing generation plus one shared pending promise/controller/timer. Only matching generation and pending identity may publish.
- Debounce observed refresh bursts by 25 ms and treat a successful value as fresh for 1,000 ms. Both values remain constructor-configurable for measurement-driven adjustment.
- Use sequential asynchronous Git commands under one total deadline and decreasing output budget; do not retry without another observed refresh signal.
- Keep `HudSnapshot.git` as the last-good render value and expose explicit `gitState` metadata.
- The service owns branch data for this slice. Native `footerData` integration remains a later surface-ownership concern.

## Non-goals

- No footer or widget visual redesign.
- No repository-wide Git abstraction rewrite.
- No background polling without an observed refresh signal.

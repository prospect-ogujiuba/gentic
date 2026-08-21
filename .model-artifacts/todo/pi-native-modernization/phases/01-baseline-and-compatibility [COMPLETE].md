# Phase 1: Baseline and compatibility

Created: 2026-08-21
Purpose: Establish a reproducible green baseline against Pi 0.84.2 before behavior or architecture changes.

## Goal

Make dependency installation, type/API compatibility, and verification trustworthy.

## Scope

- Reconcile `package.json` and `package-lock.json` with the accepted Pi support policy.
- Declare every direct runtime/type import directly, including Pi packages, `typebox`, and `@earendil-works/pi-ai` if `StringEnum` is adopted.
- Add `tsconfig.json` and a typecheck script using current Pi declarations.
- Repair `check:pi-api` so it resolves repository-local dependencies and reports the installed version.
- Generate or verify extension event names from Pi declarations; add `project_trust`, `session_info_changed`, `before_provider_headers`, and `agent_settled`.
- Add CI for clean install, typecheck, checks, and tests.

## Outputs

- Reproducible dependency/lock policy.
- Green or honestly triaged baseline.
- Generated/verified compatibility artifact and drift test.
- Setup and support-policy documentation.

## Acceptance criteria

- `npm ci` installs the intended Pi version from a clean checkout.
- `npm run typecheck`, `npm run check`, and `npm test` run without missing-package errors.
- Event drift test compares all current `ExtensionAPI.on` overloads.
- Direct imports are declared directly; wildcard dependencies are removed unless explicitly chosen.
- Node version requirement is documented and enforced.

## Verification

- Clean temporary checkout: install, typecheck, checks, full test suite.
- Assert lockfile Pi version equals the documented baseline.
- Negative fixture proves compatibility check fails when one event is omitted.

## Implementation decisions

- Support is pinned exactly to Pi 0.84.2 for the reproducible baseline.
- CI verifies only the supported baseline; a next/latest allowed-failure job is deferred to a future planning slice.

## Non-goals

- No plugin behavior redesign.
- No resource consolidation yet.

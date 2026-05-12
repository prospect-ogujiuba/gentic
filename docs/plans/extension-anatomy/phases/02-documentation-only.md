# Phase 2 — documentation only

Created: 2026-05-12
Purpose: Publish the agreed anatomy standard without changing behavior.

## Goal

Make the extension anatomy standard discoverable to maintainers and LLM agents.

## Scope

- Update `extensions/README.md`.
- Include `simple` and `layered` examples.
- Include expected README orientation fields.
- Include guidance for extension-owned resources: `skills/`, `prompts/`, `themes/`.
- Include non-goals to avoid directory theater.

## Outputs

- Updated `extensions/README.md`.
- Optional short reference to `pi-todo` as the layered example.
- Optional short reference to `pi-commands`/`pi-prompts` as simple hub examples.

## Acceptance criteria

- A new contributor can tell where new behavior should go.
- A small extension is not forced into empty layers.
- A non-trivial extension has a clear target shape.

## Verification

- Manual read-through of `extensions/README.md`.
- `npm run check` should remain unchanged if no checker exists yet.
- No runtime behavior changes.

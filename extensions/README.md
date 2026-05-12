# extensions

Code-backed Gentic behavior lives here as normal Pi extensions. This directory is the first place to look when adding Pi-facing behavior: tools, slash commands, prompt templates, themes, skills, widgets, and event hooks.

## Discovery

`package.json` points Pi at:

```txt
extensions
extensions/**/skills
extensions/**/prompts/**/*.md
extensions/**/themes/**/*.json
```

That enables both small and layered extension shapes:

- simple single-file extension: `extensions/foo.ts`
- simple folder extension: `extensions/foo/index.ts`
- extension-owned skill: `extensions/foo/skills/foo-helper/SKILL.md`
- extension-owned prompt: `extensions/foo/prompts/foo-plan.md`
- extension-owned theme: `extensions/foo/themes/foo.json`

Nested `package.json` files inside extension folders are not used for Pi package discovery. Keep extension-owned resources in the child directories above so the top-level manifest discovers them.

Use Pi runtime APIs for current state whenever possible, for example `pi.getAllTools()`, `pi.getCommands()`, `pi.getActiveTools()`, `ctx.getSystemPrompt()`, and `ctx.getContextUsage()`.

## Anatomy standard

Choose the smallest shape that honestly describes the extension. Do not add empty layers to look architectural.

### Simple extension

Use a simple shape when the extension is mostly a registration hub or a thin adapter around one resource type.

```txt
extensions/foo/
  README.md
  index.ts
```

Add child directories only when they contain owned resources:

```txt
extensions/foo/
  README.md
  index.ts
  commands/
  prompts/
  skills/
  themes/
```

Examples in this repository:

- `pi-commands` is a simple command hub: `index.ts`, `commands/`, and a small shared type file.
- `pi-prompts` is a simple prompt-template hub: `index.ts` plus `prompts/*.md`.

### Layered extension

Use a layered shape when the extension owns non-trivial state, lifecycle rules, rendering, persistence, or several Pi integration seams.

```txt
extensions/foo/
  README.md
  index.ts
  src/
    app/       # orchestration/use cases
    domain/    # durable types, reducers, policy, invariants
    pi/        # Pi API adapters, session storage, event wiring helpers
    ui/        # widgets, modal/rendering/theme output
```

`pi-todo` is the current layered example: `index.ts` wires Pi-facing registration while `src/app`, `src/domain`, `src/pi`, and `src/ui` separate workflow, rules, Pi persistence/adapters, and rendering.

## README orientation fields

Each extension folder should include a short `README.md`. For simple extensions, keep it brief. For layered or stateful extensions, include an orientation block with these fields when applicable:

- **What it does:** the behavior the extension owns.
- **Commands/tools it registers:** slash commands, prompt commands, model-callable tools, widgets, or other Pi surfaces.
- **Pi events it listens to:** event hooks such as session, turn, or tool-call listeners.
- **State/config files it reads/writes:** session entries, files, generated artifacts, or external config.
- **Internal module map:** where maintainers and LLM agents should place app/domain/Pi/UI changes.
- **Tests to run:** targeted commands before handing off or committing changes.
- **Known boundaries/non-goals:** explicit limits that prevent accidental scope expansion.

## Extension-owned resources

Resources may live with the extension that owns their behavior:

- `skills/`: repeatable agent workflows, each as `skills/<name>/SKILL.md`.
- `prompts/`: reusable prompt templates discovered from `prompts/**/*.md`.
- `themes/`: Pi theme JSON discovered from `themes/**/*.json`.

Keep resources near the code that owns their semantics. Use a central hub extension only when the resource is intentionally shared or has no stronger owner.

## Non-goals

- Do not force a small extension into `src/app`, `src/domain`, `src/pi`, or `src/ui` just to match a template.
- Do not split modules before there is real state, policy, rendering, or integration complexity to separate.
- Do not create placeholder `skills/`, `prompts/`, or `themes/` directories.
- Do not use nested `package.json` files for Pi discovery unless the top-level package manifest changes first.

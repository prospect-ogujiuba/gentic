# extensions

Code-backed Gentic behavior lives here as normal Pi extensions.

## Discovery

`package.json` points Pi at:

```txt
extensions
extensions/**/skills
extensions/**/prompts/**/*.md
extensions/**/themes/**/*.json
```

That enables both simple and complex resources:

- simple single-file extension: `extensions/foo.ts`
- complex extension folder: `extensions/foo/index.ts`
- extension-owned skill: `extensions/foo/skills/foo-helper/SKILL.md`
- extension-owned prompt: `extensions/foo/prompts/foo-plan.md`
- extension-owned theme: `extensions/foo/themes/foo.json`

Nested `package.json` files inside extension folders are not used for Pi package discovery. Keep extension-owned resources in the child directories above so the top-level manifest discovers them.

Use Pi runtime APIs for current state whenever possible, for example `pi.getAllTools()`, `pi.getCommands()`, `pi.getActiveTools()`, `ctx.getSystemPrompt()`, and `ctx.getContextUsage()`.

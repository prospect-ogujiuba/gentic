# Gentic package profiles

Profiles are documented Pi package-filter fragments, not a Gentic resource kind or runtime registry.

- `profiles/core.json`: orchestrator, catalog, scaffolding, safety, git scope, and shared primitives. It explicitly selects the root add-skill skill and git commit prompt and disables themes.
- `profiles/full.json`: every extension; omitted skill/prompt/theme keys allow all resources already admitted by `package.json#pi`.

Copy the nested `package` object into the `packages` array in global or project `.pi/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/prospect-ogujiuba/gentic@v0.1.0",
      "extensions": ["+extensions/gentic/index.ts"]
    }
  ]
}
```

`+path` is Pi's exact force-include syntax. Filters only narrow the package manifest and require no source patch. Change the pinned Git tag deliberately for upgrades; `pi update --extensions` reconciles but does not advance pinned refs.

Run `npm run check:inventory` after changing a profile. The generator rejects unknown extension paths.

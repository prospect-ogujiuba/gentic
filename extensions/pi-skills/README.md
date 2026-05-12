# pi-skills

Central extension for Gentic skills.

Skills are directories discovered by `package.json#pi.skills` from `extensions/**/skills`. Each skill lives in `skills/<name>/SKILL.md`; the directory name is the skill name.

## Anatomy

- **Mode:** `simple`
- **Public entry:** `index.ts`
- **Layers:** `pi`, `resources`
- **Resources:** `skills/`
- **Machine declaration:** `extension.anatomy.json`
- **Reference role:** simple hub example; no `src/*` layer folders are needed because skill files are discovered directly.
- **Mismatch notes:** none; `index.ts` is a no-runtime owner namespace and skill resources live in `skills/`.

## Add a skill

1. Create `skills/<name>/SKILL.md` using a lowercase kebab-case name.
2. Add YAML frontmatter:
   - `name`: must match the parent directory.
   - `description`: specific trigger/usage guidance, max 1024 characters.
3. Write focused instructions with clear workflow, success criteria, and any helper files referenced by relative path.
4. Run `/reload` in pi, then invoke it as `/skill:<name>`.

Keep skills narrow, composable, and progressively disclosed. Put long references under the skill directory and link to them from `SKILL.md`.

# command template

Copy `command.template.ts` to `extensions/pi-commands/commands/{{commandName}}.ts`, then export and add `{{camelName}}Command` in `extensions/pi-commands/commands/index.ts`.

Use this for slash commands that belong in the shared `pi-commands` hub. Extension-specific commands should live with their owning extension instead.

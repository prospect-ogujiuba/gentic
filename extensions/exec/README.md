# exec

Shell/user-bash execution behavior.

## Discovery

Extensions live at `extensions/exec/<name>/index.ts`. Put helper files beside that `index.ts`.

## Example Gentic extensions

- **Shell Wrapper** — injects environment setup before user bash commands.
- **Remote Exec Bridge** — routes shell commands to a remote workspace.
- **Command Policy** — blocks execution patterns that violate project policy.

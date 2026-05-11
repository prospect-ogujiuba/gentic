---
description: Commit the current scoped work with preferred git hygiene
argument-hint: "[extra instructions]"
---
Commit the work. Follow this exact git flow:

1. Run `git_snapshot` and `git status --short` first.
2. Identify this session's intended scope. Do not include unrelated user/agent changes.
3. Inspect candidate diffs before staging (`git diff`, and `git diff --cached` if anything is already staged).
4. Stage only scoped source files. Do not stage `.gitignore` or any files and folders listed in it unless explicitly asked.
5. If there is nothing scoped to commit, say so and stop.
6. Commit with a concise one-line message: lowercase, prefixed by work type (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
7. Show the final commit hash and remaining `git status --short`.
8. You must absolutely never touch other files in the work tree that you have used tools on

Extra instructions: $ARGUMENTS

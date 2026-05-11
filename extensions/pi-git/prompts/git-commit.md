---
description: Commit the current scoped work with preferred git hygiene
argument-hint: "[extra instructions]"
---
Commit the work. Follow this exact git flow:

# Version Control

- commit messages should be in lower case with a prefix for the type of work done in the commit
- Use surgical, concise, one-line commits focused on one unit of work.
- "Commit your work" means only the files touched by the agent in this session.

Before committing:

- Run `git status --short`.
- Check whether candidate files are ignored or tracked.
- Never assume generated plan or artifact paths should be tracked or committed.

Do not force-add ignored files with `git add -f` unless the user explicitly says to track that ignored path.

Treat all non-documentation markdown that clearly represents plans, specs, TODOs, or phase files as local runnable artifacts:

- Write them only when asked.
- Do not add or commit them unless explicitly requested.

When asked to commit:

- Stage only tracked or intended files.
- Stage only files, or sections of files, touched in this context window.
- Ignore unrelated diffs and work done by other agents in the worktree.
- Leave ignored artifacts local.

Never commit `.gitignore` without explicit instructions.

Extra instructions: $ARGUMENTS

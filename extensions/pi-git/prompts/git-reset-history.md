---
description: Dangerous reset-history workflow with explicit confirmation gates
argument-hint: "<new-root-commit-intent>"
---
The user is asking for a history reset / new initial commit. Treat this as destructive.

Before changing anything:

1. Run `git_snapshot`, `git remote -v`, and `git log --oneline --decorate -n 5`.
2. Explain exactly what will be lost locally and remotely.
3. Ask for explicit confirmation before deleting history, force-pushing, removing remotes, or recreating branches.
4. Preserve the user's preferred branch name if stated (`master` means `master`).
5. Build the new root commit from the requested scope only; remove excluded files before the initial commit.
6. Force push only after confirmation and only to the intended remote/branch.

Intent: $ARGUMENTS

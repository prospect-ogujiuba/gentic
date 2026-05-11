---
description: Push committed work safely after checking branch and remote
argument-hint: "[remote/branch/instructions]"
---
Push the work safely:

1. Run `git_snapshot` and `git status --short --branch`.
2. Confirm there is at least one local commit to push and note the current branch/upstream.
3. If the worktree is dirty, do not hide it; report what remains and decide whether it is unrelated or must be committed first.
4. Push the current branch to its upstream. If there is no upstream, choose the obvious remote (`origin`) and set upstream only if that matches the user's intent.
5. Report the pushed branch and final `git status --short --branch`.

Extra instructions: $ARGUMENTS

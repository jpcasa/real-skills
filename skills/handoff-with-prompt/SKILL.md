---
name: handoff-with-prompt
description: Writes the current task state to a handoff file, then prints a ready-to-copy prompt that starts the next agent from that file. Same file and path as a plain /handoff, plus the prompt. User-invoked only.
argument-hint: "[optional note about why you're stopping]"
disable-model-invocation: true
---

# Handoff With Prompt

Two outputs, in this order:

1. **A handoff file** so the task can be resumed cold, by you or by a future session, without re-deriving anything.
2. **A prompt in the chat** that the user copies into the next agent. It points at the file and carries enough to start if the file cannot be read.

The file is the record. The prompt is the pointer. Never put something in the prompt that is not in the file.

No script, no Jev, no network call. It writes one file and changes nothing else: no commit, no push, no stash, no tracker comment.

## 1. Locate

```bash
git rev-parse --show-toplevel
```

```bash
git rev-parse --abbrev-ref HEAD
```

The handoff path is deterministic, so a later `/catchup` or a plain `/handoff` finds the same file:

`~/.claude/handoffs/<repo-basename>--<branch with / and non-alphanumerics replaced by ->.md`

`<repo-basename>` is the basename of the first command's output. `mkdir -p ~/.claude/handoffs` first. If a handoff already exists at that path, **overwrite it**: the newest state is the only state worth keeping.

Not in a git repository: use the working directory's basename and `no-branch`, and write `not a git repo` in the State section.

## 2. Gather

- `git status --porcelain`: uncommitted files
- `git diff --stat` and `git diff --cached --stat`: shape of work in progress
- `git log --oneline @{upstream}..HEAD`: unpushed commits (skip if no upstream)
- `gh pr list --head <branch> --json number,title,url,isDraft`: open PR, if any
- What you were doing this session: the actual goal, not a summary of tool calls

If nothing is in flight (clean tree, no unpushed commits, no stated goal), write no file and print no prompt. Say so and stop.

## 3. Write the file

Keep it under 60 lines. Written for someone who has zero context.

```markdown
# Handoff — <repo> / <branch>

**Stopped:** <date> · **Why:** <$ARGUMENTS, or "context switch">

## Goal
<One paragraph. The outcome wanted, not the steps taken.>

## State
- branch `<branch>`, <N> unpushed commit(s), <N> uncommitted file(s)
- PR: <url or "none">

## Done
- <specific, verifiable things that landed>

## Next
1. <the literal next action, with file:line where known>
2. ...

## Landmines
<Things that cost time and will cost it again: failing test that is unrelated,
a migration that must run first, an env var, a decision already rejected and why.>

## Verify
<command that proves the work is correct>
```

Never write a secret into the file: name the env var or the keychain item, not its value.

## 4. Build the prompt

The reader is an agent with none of this conversation, possibly a different tool. Write it in full sentences, addressed to that agent. No caveman fragments, no "as discussed", no reference to this session.

Fill this template from the file you just wrote. Every line must be true of the file; drop a line whose value is "none" unless the template says otherwise.

```text
You are picking up work in progress on <repo>, branch `<branch>`.

Working directory: <absolute path from git rev-parse --show-toplevel>
Handoff file: <absolute handoff path, ~ expanded>

Read the handoff file first. It has the goal, what is done, what is next, and what to avoid. Then run `git status` and `git log --oneline -5` in the working directory. If git has moved on since the handoff was written (<date and time>), trust git and tell me what differs before you continue.

Goal: <the Goal section in one or two sentences>

State: <N> unpushed commit(s), <N> uncommitted file(s). PR: <url, or "none yet">.

Start with: <Next item 1, word for word, with its file:line>
Then: <Next item 2, if there is one>

Watch out for: <each landmine in one sentence; write "nothing known" if the section is empty>

It is done when: <the Verify command> passes.

Do not redo anything listed under Done. Do not push, merge, or open a pull request until I say so.
```

Rules for the prompt:

- **Absolute paths only.** The next agent may start in another directory. Expand `~`.
- **A worktree is named as one.** If the working directory is a linked worktree (`git rev-parse --git-common-dir` points outside it), add after the Working directory line: `This is a git worktree. Work here, not in the main checkout at <main repo path>.`
- **Uncommitted work is called out.** If there are uncommitted files, add to the State line: `The uncommitted changes are work in progress; do not discard them.`
- **At most 25 lines.** If it needs more, the detail belongs in the file.
- **No secrets, and nothing the file does not say.**
- **The last line stays.** The next agent starts with no approval for anything outward-facing. The user can delete the line when pasting.

## 5. Report

Print exactly this, and nothing after the code block:

1. One line: `Handoff written: <absolute path>`
2. One line: `Prompt for the next agent:`
3. The prompt, alone inside a single fenced `text` block, so it copies cleanly.

Do not re-print the file. Do not add a summary, a question or an offer after the block: the user's next move is copy and paste.

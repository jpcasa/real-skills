# GitHub

Issues and pull requests in the repo the skill runs in. Needs `gh`, authenticated.

## Setup

```json
"tracker": { "type": "github" }
```

## Fetch

```bash
gh issue view <n> --json number,title,body,state,labels,comments,url
gh pr view <n> --json number,title,body,state,headRefName,files,closingIssuesReferences,url
```

Tickets waiting for QA, when the user named nothing: `gh issue list --state open --label qa --limit 10 --json number,title,url` (use the repo's own label if it has one).

## Comment

```bash
gh issue comment <n> --body-file <body_file>      # a ticket
gh pr comment <n> --body-file <body_file>         # a PR item
```

Always `--body-file`: inline text breaks on backticks and `$`. The command prints the comment URL; pass it to `post-record`.

## Attach

GitHub has no API for uploading an image into a comment, so screenshots go on an orphan branch of the same repository and are embedded by URL. **This is a push to the repository**, and anyone who can read the repo can see the images. The plan question says so.

```bash
MAIN=$(git rev-parse --show-toplevel)
EV="$MAIN/.claude/worktrees/qa-evidence"
if git -C "$MAIN" ls-remote --exit-code --heads origin qa-evidence >/dev/null; then
  git -C "$MAIN" fetch origin qa-evidence
  git -C "$MAIN" worktree add -B qa-evidence "$EV" origin/qa-evidence
else
  git -C "$MAIN" worktree add --orphan -b qa-evidence "$EV"      # git >= 2.42
fi
mkdir -p "$EV/<run-id>/<item>"
cp <each attachment path> "$EV/<run-id>/<item>/"
git -C "$EV" add "<run-id>/<item>"
git -C "$EV" commit -m "qa evidence <run-id> <item>"
git -C "$EV" push -u origin qa-evidence
git -C "$MAIN" worktree remove "$EV"
```

Replace each `{{shot:<path>}}` in the body with `https://github.com/<owner>/<repo>/blob/qa-evidence/<run-id>/<item>/<file>?raw=true`.

- Never force-push `qa-evidence`. It is append-only.
- If a ruleset blocks the branch, post the comment without the image lines and tell the user where the files are.

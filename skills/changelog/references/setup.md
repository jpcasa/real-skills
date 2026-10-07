# Setup — writes `.claude/changelog.json`

Runs on first use or on `/real-skills:changelog setup`. Look facts up; ask only for decisions. **One** question round for everything below (AskUserQuestion in Claude Code, a single chat message elsewhere), with the detected value as the recommended option.

## 1. Repo and branches (look up)

```bash
gh repo view --json nameWithOwner,defaultBranchRef
git ls-remote --heads origin production staging release
git tag --list --sort=-creatordate | head -20
```

## 2. Release model (detect, then confirm)

- **promotion**: a branch such as `production` exists and has merged PRs into it (`gh pr list --base <branch> --state merged --limit 3`). Record `production_branch`.
- **tags**: otherwise, if tags exist. Propose `tag_pattern` from what the tags look like (`v*`, `release-*`, …).
- Neither: tell the user the skill needs promotion PRs or tags, and stop.

## 3. Tracker (ask)

Ask which tracker the team uses for tickets. Options: **GitHub Issues**, **ClickUp**, **Linear**, **None (PRs only)**. "Other" covers anything else, e.g. Jira, Asana, Shortcut, Notion.

Before asking, sample the last 30 merged PRs so the question can carry a recommendation:

```bash
gh pr list --repo <repo> --state merged --limit 30 --json number,headRefName,body \
  --jq '.[] | .headRefName + " " + .body' > /tmp/changelog-sample.txt
grep -oiE 'app\.clickup\.com/t/[0-9a-z/]+|\bCU-[0-9a-z]+' /tmp/changelog-sample.txt | head   # ClickUp
grep -oiE 'linear\.app/[^ )]+/issue/[A-Z]+-[0-9]+|\b[A-Z]{2,6}-[0-9]+\b' /tmp/changelog-sample.txt | head  # Linear / Jira-style
grep -oiE '(fixes|closes|resolves) #[0-9]+' /tmp/changelog-sample.txt | head        # GitHub Issues
```

Then follow the chosen adapter's **Setup** section (`trackers/<type>.md`) to fill in its fields: ID pattern, URL template, and the scope for the In-progress query.

- The tracker has no connector or CLI in this session: say which one is needed, write the config anyway, and note that In progress will be skipped until it's connected.
- The ID pattern must match the IDs seen in the sample. Test it with `grep -oiE '<pattern>' /tmp/changelog-sample.txt` and show the hits.

## 4. Areas (optional)

Propose 3–7 areas from PR labels and top-level changed paths. Empty is fine; the skill then infers per run.

## 5. Defaults that remove a question (ask, same round)

- **Default audience**: `technical`, `non-technical`, or "ask each time" (leave `default_audience` out). With a default set, `/changelog` with no audience argument does not ask.
- **Jev**: `"jev": "shadow"` (default) lets `scripts/judge.mjs` send each PR's title, body, branch, labels and file paths to api.typesafe.ai, redacted, when a TypeSafe key is present. Say that plainly when asking. `"off"` sends nothing; the code rules still run.

## 6. Write and show

Write `<repo>/.claude/changelog.json` (shape: `config.example.json`), print it, and suggest committing it so teammates get the same setup.

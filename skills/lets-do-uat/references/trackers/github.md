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

## PRs

For an issue: PRs that close it, then PRs that mention it.

```bash
gh pr list --state all --search "<n> in:body" --json number,title,state --limit 10
```

For a PR argument the PR itself is the work; add any PR it names as stacked on.

## Comment

```bash
gh issue comment <n> --body-file <body_file>      # a ticket
gh pr comment <n> --body-file <body_file>         # a PR
```

Always `--body-file`. The command prints the comment URL; pass it to `post-record`.

# Linear

Needs a Linear connector in the session.

## Setup

```json
"tracker": { "type": "linear", "id_pattern": "\\b(ENG|OPS)-[0-9]+\\b", "url_template": "https://linear.app/<workspace>/issue/{id}" }
```

## Fetch

Get the issue by identifier, with its description, comments and attachments.

## PRs

Linked PRs are attachments on the issue (GitHub integration) and show in `branchName`. Then `gh pr list --state all --search "<id>" --json number,title,state --limit 10`.

## Comment

Create a comment on the issue with the content of `body_file` as its body (with Composio: `LINEAR_CREATE_LINEAR_COMMENT { issueId: "ENG-123", body }`). Mention nobody. The comment's URL goes to `post-record`.

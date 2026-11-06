# ClickUp

Needs a ClickUp connector in the session. Tool names differ by host; find them by keyword `clickup`.

## Setup

```json
"tracker": { "type": "clickup", "id_pattern": "86[0-9a-z]{7}", "url_template": "https://app.clickup.com/t/{id}" }
```

## Fetch

`clickup_get_task` with the bare id (strip any `CU-` prefix), then `clickup_get_task_comments`. Read the description, checklists and custom fields for acceptance criteria.

## PRs

ClickUp keeps no PR list of its own. Look, in order: GitHub links in the description and comments, the task's linked-PR field if the workspace has the GitHub integration, then `gh pr list --state all --search "<id>" --json number,title,state --limit 10` (branch names and PR titles usually carry the id).

## Comment

`clickup_create_comment { entity_type: "task", entity_id: <id>, comment_text: <content of body_file> }`. Mention nobody. The URL for `post-record` is the task URL.

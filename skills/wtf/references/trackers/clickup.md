# ClickUp

## Setup

```json
"tracker": { "type": "clickup", "id_pattern": "86[0-9a-z]{7}", "url_template": "https://app.clickup.com/t/{id}", "list_ids": ["<bug list id>"] }
```

- `id_pattern`: a regex for the task ids seen in recent PRs and tickets. Teams using custom task ids (`ENG-123`) use that shape.
- `list_ids`: the lists bug reports land in. Used for **Latest** and to scope searches.

Needs a ClickUp connector in the session. Tool names differ by host; find them by keyword `clickup`.

## Fetch

`clickup_get_task` with the bare id (strip any `CU-` prefix), then `clickup_get_task_comments`.

## Search prior art

`clickup_search` on the distinctive nouns. Two or three scoped queries, never an enumeration of a list. Include closed tasks.

Each call is one `spend --kind tracker`. The API rate limit is shared with every other skill in the session, so the budget is a real limit, not a courtesy.

## Latest

The newest tasks in `list_ids` with an open status: one `clickup_filter_tasks` call, newest first, limit N.

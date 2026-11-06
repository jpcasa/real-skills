# Other trackers

Jira, Asana, Shortcut, Notion, or anything else with a connector in the session.

## Setup

```json
"tracker": { "type": "other", "name": "jira", "id_pattern": "\\b(PROJ)-[0-9]+\\b", "url_template": "https://example.atlassian.net/browse/{id}" }
```

## Fetch

The connector's read tools: one item with its description and comments.

## PRs

Development links on the item if the tracker has them, then `gh pr list --state all --search "<id>" --json number,title,state --limit 10`.

## Comment

The connector's add-comment tool, with the content of `body_file` unchanged. No connector, or not signed in: print the body for the user to paste, and record `not_posted` with the reason.

# Other trackers

Jira, Asana, Shortcut, Notion, or anything else with a connector in the session.

## Setup

```json
"tracker": { "type": "other", "name": "jira", "id_pattern": "\\b(PROJ)-[0-9]+\\b", "url_template": "https://example.atlassian.net/browse/{id}" }
```

## Fetch

Use the connector's read tools: one item with its description and comments. For "waiting for QA", list the newest items in the team's QA status, limit 10.

## Comment

The connector's add-comment tool, with the content of `body_file` unchanged. One comment per item. If the tracker does not render Markdown, post it as it is; do not rewrite it.

## Attach

The connector's attach-file tool, if it has one, then replace each `{{shot:<path>}}` with the returned URL. Without one, replace each image line with `Screenshot kept locally: <file name>`.

No connector, or not signed in: print the body for the user to paste, and record `not_posted` with the reason.

# Other trackers

Jira, Asana, Shortcut, Notion, or anything else with a connector in the session.

## Setup

```json
"tracker": { "type": "other", "name": "jira", "id_pattern": "\\b(PROJ)-[0-9]+\\b", "url_template": "https://example.atlassian.net/browse/{id}" }
```

## Fetch, Search prior art, Latest

Use the connector's read tools: get one item with its comments; search on the distinctive nouns in two or three scoped queries, all states; list the newest open bug items.

Each call is one `spend --kind tracker`. Read-only calls only. If the connector is missing or unauthenticated, say so and continue without the tracker: the report then states that prior art was not checked there.

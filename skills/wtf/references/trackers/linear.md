# Linear

## Setup

```json
"tracker": { "type": "linear", "id_pattern": "\\b(ENG|OPS)-[0-9]+\\b", "url_template": "https://linear.app/<workspace>/issue/{id}" }
```

`id_pattern` is built from the team keys. Match case-insensitively and upper-case the result.

Needs a Linear connector in the session.

## Fetch

Get the issue by identifier, with its comments.

## Search prior art

Search issues on the distinctive nouns, two or three scoped queries, all states. A cancelled or completed issue is a decision.

Each call is one `spend --kind tracker`.

## Latest

The newest issues in triage or backlog with a bug label, limit N.

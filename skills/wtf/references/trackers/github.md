# GitHub Issues

## Setup

```json
"tracker": { "type": "github" }
```

Issues are read from the repo the skill runs in. Needs `gh`, authenticated.

## Fetch

```bash
gh issue view <n> --json number,title,body,state,labels,createdAt,author,comments,url
```

## Search prior art

Two or three scoped queries on the distinctive nouns of the report, never the whole sentence. Open **and** closed: a closed issue is a decision, and that decision may be the answer.

```bash
gh issue list --state all --search "<nouns> in:title,body" --limit 10 --json number,title,state,url,closedAt
gh pr list --state all --search "<nouns>" --limit 10 --json number,title,state,mergedAt,url
```

Each call is one `spend --kind tracker`.

## Latest

```bash
gh issue list --state open --label bug --limit <N> --json number,title,createdAt,url
```

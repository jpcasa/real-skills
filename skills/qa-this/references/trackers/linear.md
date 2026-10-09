# Linear

Needs a Linear connector in the session.

## Setup

```json
"tracker": { "type": "linear", "id_pattern": "\\b(ENG|OPS)-[0-9]+\\b", "url_template": "https://linear.app/<workspace>/issue/{id}" }
```

`id_pattern` is built from the team keys.

## Fetch

Get the issue by identifier, with its description, comments and attachments. A linked PR shows up as an attachment or in `branchName`.

Tickets waiting for QA, when the user named nothing: list issues in the team's QA or review state, newest first, limit 10.

## Comment

Create a comment on the issue with the content of `body_file` as its body (with Composio: `LINEAR_CREATE_LINEAR_COMMENT { issueId: "ENG-123", body }`). Mention nobody. The comment's URL goes to `post-record`.

## Attach

One file at a time; the signed upload URL expires in about a minute.

1. Ask for an upload URL: the `fileUpload` mutation with `contentType`, `filename` and `size` (or the connector's prepare-attachment tool).
2. `PUT` the bytes to `uploadUrl` with every returned header, verbatim.
3. Replace the matching `{{shot:<path>}}` with the returned `assetUrl`.

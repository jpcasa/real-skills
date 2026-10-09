# ClickUp

Needs a ClickUp connector in the session. Tool names differ by host; find them by keyword `clickup`.

## Setup

```json
"tracker": { "type": "clickup", "id_pattern": "86[0-9a-z]{7}", "url_template": "https://app.clickup.com/t/{id}" }
```

## Fetch

`clickup_get_task` with the bare id (strip any `CU-` prefix), then `clickup_get_task_comments`. The task's linked PR or branch name is usually in a comment or the description.

Tickets waiting for QA, when the user named nothing: one `clickup_filter_tasks` call on the lists the team works in, for the status the team uses for QA or review, newest first, limit 10.

## Comment

`clickup_create_comment { entity_type: "task", entity_id: <id>, comment_text: <content of body_file> }`

Markdown is supported. Mention nobody: the comment is evidence, not an ask. The result has the comment id; the URL for `post-record` is the task URL.

## Attach

| File | Tool |
|---|---|
| Local PNG | `clickup_request_attachment_upload { task_id, file_name }`, then upload exactly as the result instructs |
| Local file under ~200 KB | `clickup_attach_task_file { task_id, file_name, file_data: <base64, no data: prefix> }` |

If the upload returns a file URL, replace the matching `{{shot:<path>}}` with it. If it does not, replace the image line with `Attached: <file name>`.

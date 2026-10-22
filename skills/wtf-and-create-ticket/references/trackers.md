# Trackers

Tool names differ by host; find a connector's tools by keyword (`clickup`, `linear`). Composio works too (`COMPOSIO_SEARCH_TOOLS` for the toolkit, then name the account).

Config fields are generic; this is how each tracker takes them.

| Config | ClickUp | GitHub | Linear |
|---|---|---|---|
| `destination` | `list_id` | `repo` (`owner/name`, default: this repo), `project` (Projects board title, optional) | `team` (key), `project` (optional) |
| `type` | `task_type` (`Bug`, `Feature`) | an issue type if the org has them, else a label | a label |
| `status` | `status` | `project` column; issues have none of their own | `state` |
| `priority` | `priority` (`urgent`, `high`, `normal`, `low`) | a label (`priority:high`) | `priority` (1 urgent … 4 low) |
| `assignees` | `assignees` (user ids) | `--assignee` (logins) | `assignee` (one user) |
| `labels` | `tags` (must exist in the space) | `--label` (must exist) | `labels` |
| `custom_fields` | `custom_fields` `[{id, value}]` | — | — |

`outage` sets `priority` to `urgent`: on GitHub use the repo's highest priority label, on Linear priority 1.

## ClickUp

**Setup.** `clickup_get_workspace_hierarchy` for spaces, folders and lists; ask which list is the project's. `clickup_get_list` for its statuses, `clickup_get_workspace_members` or `clickup_find_member_by_name` for assignee ids, `clickup_get_custom_fields` on the list for required fields and dropdown option ids.

**Create.** `clickup_create_task { list_id, name: title, markdown_description: <body_file>, task_type, status, priority, assignees, tags: labels, custom_fields }`. The result has the task id and URL.

**Attach.** Each file under ~200 KB: `clickup_attach_task_file { task_id, file_name, file_data: <base64, no data: prefix> }`. Larger: `clickup_request_attachment_upload`, then upload as its result says.

## GitHub

Needs `gh`, authenticated.

**Setup.** `gh label list`, `gh api repos/{owner}/{repo}/assignees --jq '.[].login'`, `gh project list --owner <owner>` and `gh project field-list <n> --owner <owner>` when the team uses a board.

**Create.**

```bash
gh issue create --repo <repo> --title "<title>" --body-file <body_file> --label <label> --assignee <login>
```

One `--label` / `--assignee` per value; `type` and `priority` are labels too. Always `--body-file`: inline text breaks on backticks and `$`. With a board: `gh project item-add <n> --owner <owner> --url <issue url>`, then set its status field with `gh project item-edit`. The create prints the issue URL; the number is its last segment.

**Attach.** GitHub has no file attachments: one comment per file, `gh issue comment <n> --body-file <file>`, starting with the file's repo path as a heading.

## Linear

**Setup.** List teams, then the team's workflow states, labels, members and projects.

**Create.** Create the issue in `team` with `title`, `description: <body_file>`, `stateId`, `priority`, `assigneeId`, `labelIds`, `projectId` (Composio: `LINEAR_CREATE_LINEAR_ISSUE`). The result has the identifier (`ENG-123`) and URL.

**Attach.** One comment per file with its content, headed by the file's repo path.

## Other

Ask the user how tickets are created there. Without a tool that reaches it, print the title, fields and body for the user to paste, and `record` the id they give back.

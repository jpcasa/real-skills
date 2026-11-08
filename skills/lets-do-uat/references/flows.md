# Writing UAT flows

A flow is one path a real user takes through the feature, from a page they open to an outcome they can see. The flows file is the reference the team keeps, so write it for a person who has never seen the ticket.

## Which flows

From the ticket's acceptance criteria and the PRs' diff, in this order:

1. **The main path**: the job the feature exists for, done the normal way.
2. **Each other change a user would notice**: a new option, filter, state, role or setting the diff adds. One flow each, unless two fit in one path.
3. **The unhappy path the diff handles**: the validation message, the empty state, the permission denied, the error the code now shows. Only if the diff adds or changes it.
4. **For a bug fix**: the exact reproduction from the ticket, now expected to work. Then one nearby path the fix could break.

At most 8 flows. Fewer is better: drop what the diff does not touch. No flow for code with no screen (a job, a migration): say in the summary it is outside UAT.

## Notes for the whole set

`notes.requires`: what every flow needs that is not a step, such as a feature flag, a seed or a setting. `notes.not_covered`: what the PRs change that no flow reaches, each with the reason. Both show on the draft the user approves, so a gap is a decision, not an accident.

## Each flow

| Field | Rule |
|---|---|
| `id` | Short kebab-case, unique: `approve-request` |
| `title` | What the user does, in their words: "Approve a transport request" |
| `goal` | One sentence: who, and what they achieve |
| `role` | Who must be signed in, as the app names it: "Dispatcher", "Org admin", "Signed out". Required: the next tester needs it to repeat the flow |
| `section` | Where in the app it happens, as the user navigates there: "Operations > Transport requests". Required |
| `start_path` | The path to open, starting with `/`. No tokens or session ids in it |
| `preconditions` | What must be true first: role, data that must exist, a feature flag. At most 5 |
| `steps` | 1 to 15, each `{action, expected}` |

## Each step

- `action`: one thing a person does, naming what they see on screen, with the exact visible text of what to use (it is how the guide rings it on the screenshot): "Click **Approve** on the request's detail panel". Not "approve it", not two clicks in one step.
- `expected`: what they see right after, checkable by eye: "The status badge turns to Approved and the button disappears".
- Words like delete, pay, send, submit, invite, publish or approve mark a step ⚠: in agent mode the user says yes before it is done. Write those verbs plainly; never soften them to dodge the mark.
- Last step of every flow: check the outcome where it lands (the list, the record, the email preview), not just the toast.

## Example

```json
{
  "id": "approve-request",
  "title": "Approve a transport request",
  "goal": "A dispatcher approves a pending request so the driver can be assigned.",
  "role": "Dispatcher",
  "section": "Operations > Transport requests",
  "start_path": "/requests?status=pending",
  "preconditions": ["Signed in as a dispatcher", "At least one pending request"],
  "steps": [
    { "action": "Click the first transport request in the list", "expected": "Its detail panel opens with status Pending" },
    { "action": "Click Approve", "expected": "The badge turns to Approved and the Approve button is gone" },
    { "action": "Go back to the list", "expected": "The request no longer shows under Pending" }
  ]
}
```

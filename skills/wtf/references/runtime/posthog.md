# PostHog

## Config

```json
"runtime": { "posthog": { "project_id": "1234" } }
```

Use the session's PostHog connector. Read-only.

## What to look up

Only when the report has a time and a user or tenant. Window: 30 minutes either side.

- The user's events in the window: which screens, which actions, in what order (one read). This shows what they actually did, which often differs from what they said they did.
- For a "nothing happened" report: did the action event fire at all?

Each read is one `spend --kind runtime`.

## What it is worth

- The real sequence of steps is the best input for a reproduction plan.
- "The action event never fired" supports `enabled_noop` only together with the handler read from source.
- Pass results to `verdict` as `{"source":"posthog","kind":"error"|"none","matches_code":true|false}`. Use `kind: "error"` only for a recorded failure, not for an ordinary event trail.

Session recordings and person profiles hold personal data. Read what the question needs; never paste them into the report, and never into anything sent to Jev.

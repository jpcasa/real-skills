# Sentry

## Config

```json
"runtime": { "sentry": { "org": "acme", "project": "web" } }
```

Use whatever the session has: a Sentry connector, or `sentry-cli` if it is installed and authenticated. Read-only.

## What to look up

Only when the report has a time. Window: 30 minutes either side of it, in the environment the report came from, narrowed by user or tenant when the report names one.

1. Issues with events in the window (one read).
2. For the most relevant one, the latest event: exact error message, top frames, release (one read).

Each read is one `spend --kind runtime`. Four per run, shared with the other runtime sources.

## What it is worth

- An exact error string is something to search the code for. That is its main use.
- An error whose frames are in the code path you cited corroborates: pass it to `verdict` as `{"source":"sentry","kind":"error","matches_code":true}`.
- An error that only shares the time window is a lead, `matches_code: false`.
- No error proves nothing. Silent no-ops throw nothing. Pass `{"source":"sentry","kind":"none"}`.

The harness never accepts a verdict on runtime evidence alone.

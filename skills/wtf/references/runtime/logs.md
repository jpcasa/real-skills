# Logs

## Config

```json
"runtime": { "logs": { "how": "<read-only command or connector>" } }
```

`how` is the read-only command or connector this repo uses to read application logs (a host CLI, a log platform's connector). Logs kept by the host itself (CloudWatch on AWS, Render, Vercel, Fly) belong under `hosting`: see [hosting.md](hosting.md). Use this key for a separate log platform. If neither is set, skip logs.

## What to look up

Only when the report has a time. Window: 30 minutes either side, filtered by the request path, user id or error string you already have. One query per `spend --kind runtime`.

## What it is worth

Same as the other runtime sources: an exact error string to search the code for, and corroboration when it comes from the code path you cited. Absence of a log line proves nothing.

Never run a log command that writes, tails indefinitely, or targets a host you were not given. Logs can hold secrets and personal data: quote the one line that matters, never a dump.

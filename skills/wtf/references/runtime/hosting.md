# Hosting — where the app runs

The host is a source like the tracker: it knows what is deployed and what the app logged. Which host is a per-repo fact, set once in `.claude/wtf.json`.

## Config

```json
"hosting": { "provider": "aws", "service": "web-api", "region": "us-east-1", "logs": "aws logs tail /ecs/web-api --since 1h", "deployed": "aws ecs describe-services --cluster main --services web-api" }
```

- `provider`: `aws`, `render`, `vercel`, `fly`, `netlify`, `heroku`, `railway`, `cloudflare`, `gcp`, `azure`, `other`.
- `service`, `region`: whatever names the one thing to look at. Optional.
- `logs`, `deployed`: the read-only command or connector tool this repo uses. Optional; without them use the table below.

Use whatever the session has: the provider's connector if one is connected, otherwise its CLI if installed and signed in. If neither, say so and continue: the report then states the host was not checked.

## Read-only starting points

| Provider | Logs around a time | What is deployed now |
|---|---|---|
| `aws` | `aws logs filter-log-events --log-group-name <group> --start-time <ms> --end-time <ms> --filter-pattern <text>` | `aws ecs describe-services`, `aws lambda get-function`, `aws amplify list-jobs`, by what the repo deploys to |
| `render` | Render connector `list_logs`, or `render logs --resources <service>` | connector `list_deploys`, or `render deploys list <service>` |
| `vercel` | `vercel logs <deployment-url>` | `vercel ls --prod`, `vercel inspect <url>` |
| `fly` | `flyctl logs -a <app> --no-tail` | `flyctl releases -a <app>` |
| `netlify` | function logs in the dashboard or connector | `netlify api listSiteDeploys --data '{"site_id":"<id>"}'` |
| `heroku` | `heroku logs -n 500 -a <app>` | `heroku releases -a <app>` |
| `railway` | `railway logs` | `railway status` |
| `cloudflare` | `wrangler tail` is a live tail: do not use it. Use the dashboard or a connector | `wrangler deployments list` |
| `gcp` | `gcloud logging read '<filter>' --freshness=1h --limit=100` | `gcloud run revisions list`, `gcloud app versions list` |
| `azure` | `az monitor log-analytics query` | `az webapp deployment list-publishing-profiles` is a secret: never. Use `az webapp show` |
| `other` | the `logs` command from config | the `deployed` command from config |

## What to look up

1. **What is deployed**, when a fix exists: the commit or image the host is running. One read. The harness's `skew` answers from git; the host answers from what actually shipped. When they disagree, the host wins and the report says both.
2. **Logs**, only when the report has a time: 30 minutes either side, filtered by the request path, user id or error string you already have.

Each read is one `spend --kind runtime`. Four per run, shared with the other runtime sources.

## What it is worth

Same as the other runtime sources: an exact error string to search the code for, and corroboration when it comes from the code path you cited: `{"source":"hosting","kind":"error","matches_code":true}`. Absence of a log line proves nothing. The harness never accepts a verdict on runtime evidence alone.

## Never

- A command that writes, deploys, restarts, scales, tails without end, or prints secrets or environment variables.
- A host, account, region or service you were not given in config.
- A log dump in the report. Logs hold secrets and personal data: quote the one line that matters.

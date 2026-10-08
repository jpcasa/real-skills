# Setup — writes `.claude/wtf.json`

Runs on `/real-skills:wtf setup`. Pasted text and screenshots need no setup; links, runtime evidence and reproduction do. Look facts up; ask only for decisions. **One** question round for everything below, with the detected value as the recommended option.

## 1. Look up

```bash
gh repo view --json nameWithOwner,defaultBranchRef
git ls-remote --heads origin production staging release
git tag --list --sort=-creatordate | head -5
ls .claude/changelog.json .claude/launch.json vercel.json 2>/dev/null
```

- `.claude/changelog.json` exists: reuse its `tracker` and `release` as the recommended values. Do not copy `release` into `wtf.json`; the script reads it from there.
- `launch.json`, `vercel.json`, README, deploy docs: candidate environments and hosts.

## 2. Ask (one round)

| Key | Question | Notes |
|---|---|---|
| `tracker` | Which tracker holds bug tickets? GitHub Issues, ClickUp, Linear, other, none | Then the adapter's **Setup** section in `trackers/<type>.md` |
| `inbox` | Is there a support inbox to read reports from? | Optional. Needs the URL shape of one conversation. See [inbox.md](inbox.md) |
| `environments`, `production_hosts` | Which non-production environments exist, and which hosts are production? | **`production_hosts` is what makes reproduction possible.** Without it the script refuses to reproduce anywhere. List every production host, including regional ones |
| `runtime` | Sentry, PostHog, logs? | Optional. Only what this session can actually reach. See `runtime/` |
| `default_register` | `tech`, `plain`, or ask each time | Leave out to be asked |
| `jev` | `shadow` (default), `live`, `off` | Say plainly what is sent: a one-line symptom summary written without names, prior-ticket titles, and the expected/actual lines, scrubbed. Never the report |

## 3. Heuristics (optional)

Offer to create the file named by `heuristics` (default `.claude/wtf-heuristics.md`) with the product's own traps: which guards people misread, which screens hide prerequisites, what "it worked last week" has meant before. Start it from what the tracker's closed bug tickets show. Empty is fine.

## 4. Write and show

Write `<repo>/.claude/wtf.json` (shape: `config.example.json`), print it, and suggest committing it. It holds no secrets: hosts, ids and patterns only.

# Setup — writes `.claude/wtf.json`

Every repo keeps its bugs, runs and monitoring somewhere different: one is ClickUp and AWS, the next is Linear and Render. Setup records that once per repo, so every later run knows where to gather context.

It runs in two cases:

- `/real-skills:wtf setup`, at any time, to create or change the file.
- **The first run in a repo.** `start` returns `setup` in `needs` when `.claude/wtf.json` does not exist. Say so in one line and run the steps below before triaging. The user may answer "not now": then triage this report with what was pasted and no sources, write nothing, and say which sources were skipped. They will be asked again next time.

Look facts up; ask only for decisions. **One** question round for everything, with the detected value as the recommended option.

## 1. Look up

```bash
printf '%s' '{"repo":"<absolute repo root>"}' | $H probe
```

`probe` reads file names, dependency names, branch names and commit subjects, and returns candidates with the reason for each:

| Field | Becomes the recommended answer for |
|---|---|
| `tracker[]` | Which tracker. `reuse` means `.claude/changelog.json` already answered it: offer the same |
| `hosting[]` | Where the app runs. `cli_installed` says whether the host's CLI is on this machine |
| `runtime[]` | Error and analytics sources the code already reports to |
| `release` | Production and staging branches, latest tag. `reuse: true`: `.claude/changelog.json` has it, do not ask and do not copy it |
| `local[]` | Files that describe a local environment |

Then check what **this session** can reach, because a source nobody can read is not a source: for each candidate, is there a connected tool for it (a ClickUp, Linear, Sentry, PostHog, AWS or Render connector) or an installed, signed-in CLI? Offer only what can be read. Name the rest as "detected, not reachable from this session" so the user can connect it and rerun setup.

An empty `probe` is normal for a new repo. Ask without a recommendation.

## 2. Ask (one round)

| Key | Question | Notes |
|---|---|---|
| `tracker` | Which tracker holds bug tickets? GitHub Issues, ClickUp, Linear, other, none | Then the adapter's **Setup** section in `trackers/<type>.md` |
| `hosting` | Where does the app run? AWS, Render, Vercel, Fly, other, none | Then which service to look at, and how logs are read. See [runtime/hosting.md](runtime/hosting.md) |
| `runtime` | Which of Sentry, PostHog, logs can be read? | Optional. See `runtime/` |
| `environments`, `production_hosts` | Which non-production environments exist, and which hosts are production? | **`production_hosts` is what makes reproduction possible.** Without it the script refuses to reproduce anywhere. List every production host, including regional ones |
| `inbox` | Is there a support inbox to read reports from? | Optional. Needs the URL shape of one conversation. See [inbox.md](inbox.md) |
| `default_register` | `tech`, `plain`, or ask each time | Leave out to be asked |
| `jev` | `shadow` (default), `live`, `off` | Say plainly what is sent: a one-line symptom summary written without names, prior-ticket titles, and the expected/actual lines, scrubbed. Never the report |

Four questions fit one round: tracker, hosting, runtime, environments. Ask the last three rows only when the user wants them; their defaults are safe.

"None" is a real answer and is written down (`"tracker": {"type": "none"}`), so the skill stops asking.

## 3. Heuristics (optional)

Offer to create the file named by `heuristics` (default `.claude/wtf-heuristics.md`) with the product's own traps: which guards people misread, which screens hide prerequisites, what "it worked last week" has meant before. Start it from what the tracker's closed bug tickets show. Empty is fine.

## 4. Write and show

Write `<repo>/.claude/wtf.json` (shape: `config.example.json`), print it, and suggest committing it so teammates are not asked again. It holds no secrets: hosts, ids, service names and patterns only. Never write a token, key or password into it.

Then run `start` again and continue with the report the user came with.

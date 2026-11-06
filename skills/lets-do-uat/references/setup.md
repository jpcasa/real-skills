# Setup: the config this skill reads

Setup runs in two cases: `/real-skills:lets-do-uat setup`, or the first run in a repo where `start` returns `setup` in `needs`. `missing` lists exactly what no config file answers. Say so in one line, then do the steps below. Look facts up; ask only for decisions, in **one** round, with the detected value as the recommended option.

## What is read, and from where

| Key | Read from, first match wins |
|---|---|
| `tracker` | `.claude/lets-do-uat.json`, `.claude/qa-this.json`, `.claude/wtf.json`, `.claude/changelog.json` |
| `environments`, `production_hosts` | `.claude/lets-do-uat.json`, `.claude/qa-this.json`, `.claude/wtf.json` |
| `rag`, `docs_dir`, `post`, `jev` | `.claude/lets-do-uat.json` only |

**Do not copy a key another file already answers.** A repo set up for `/qa-this` or `/wtf` needs nothing more.

## Ask (one round)

Only the keys in `missing`:

| Key | Question | Notes |
|---|---|---|
| `tracker` | Which tracker holds the tickets: ClickUp, GitHub Issues, Linear, other, none? | Then the adapter's **Setup** section in `trackers/<type>.md` |
| `environments` | Which environments can UAT open, with their base URLs? | `{name, kind, base_url}`; `kind` is `local`, `preview`, `staging` or `production` |
| `production_hosts` | Which hosts are production? | **Agent mode refuses any environment it cannot show is not production**: with this list empty, agent mode never runs. An entry covers the host and everything under it; `=host` covers that host only |

Defaults that need no question: `docs_dir: "docs/uat"`, `post: "ask"`, `jev: "shadow"`. Mention them once.

The RAG answer is not asked here: `start` asks it the first time it sees a retrieval feature, and `rag` saves it as `"rag": {"enabled": true|false, "signals": [...], "asked": "<date>"}`. To change it later, edit that key or delete it to be asked again.

## Write

Write only the keys that were asked, keeping any key already in the file:

- `tracker`, `environments`, `production_hosts` go into `.claude/qa-this.json`. `/qa-this`, `/wtf`, `/promote`, `/check-infra-and-migrations` and `/improve-design` read them from there, so the repo is set up once for all of them.
- `docs_dir`, `post`, `jev` go into `.claude/lets-do-uat.json`.

Show what was written, then call `start` again with the user's arguments. `config_sources` shows which file answers each key.

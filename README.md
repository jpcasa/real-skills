# real-skills

Skills for everyday engineering work, packaged as one plugin. Install once, get every skill. Works in Claude Code and Codex (`do-shit` needs Claude Code).

## Which skill do I want?

| You want to… | Use | Writes to |
|---|---|---|
| Hand over tracker tickets and get reviewed, merged PRs back | [`do-shit`](#do-shit) | Branches, PRs, tracker statuses and comments (all behind approval gates) |
| Tell people what shipped in the last releases | [`changelog`](#changelog) | One Markdown file. Read-only everywhere else |
| Pin down a small task before building it | [`quick-ask-me`](#quick-ask-me) | `CONTEXT.md` terms, the occasional ADR |

**Contents:** [Install](#install) · [Requirements](#requirements) · [do-shit](#do-shit) · [changelog](#changelog) · [quick-ask-me](#quick-ask-me) · [Repo layout](#repo-layout) · [Develop](#develop) · [License](#license)

## Install

### Claude Code

```bash
claude plugin marketplace add jpcasa/real-skills
```

```bash
claude plugin install real-skills@jpcasa-skills
```

Or inside a session: `/plugin marketplace add jpcasa/real-skills`, then `/plugin install real-skills@jpcasa-skills`.

Start a new session afterwards. Commands carry the plugin prefix: `/real-skills:changelog`.

To update later:

```bash
claude plugin marketplace update jpcasa-skills
```

### Codex

```bash
npx skills add jpcasa/real-skills -a codex
```

This copies the skills into Codex's skills folder. Invoke them without the prefix: `/changelog`, `/quick-ask-me`. The repo also ships Codex plugin manifests (`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`) for plugin-aware installs.

### Support

| Skill | Claude Code | Codex |
|---|---|---|
| `do-shit` | ✓ | ✗ Needs Claude Code subagents, plugin agents and hooks. Stops with a message elsewhere |
| `changelog` | ✓ | ✓ Tracker connectors must be configured in Codex too |
| `quick-ask-me` | ✓ | ✓ |

## Requirements

| Needed for | What |
|---|---|
| Everything | `git`, `gh` (authenticated) |
| `do-shit`, `changelog` | `jq` |
| `do-shit` | Node 20+ |
| GitHub Issues | `gh` only |
| ClickUp | A ClickUp MCP connector, e.g. the claude.ai ClickUp connector |
| Linear | A Linear MCP connector. `do-shit` uses [Composio](https://composio.dev)'s `linear` toolkit |
| Jev (optional, `do-shit` only) | A [TypeSafe](https://typesafe.ai) API key in `TYPESAFE_API_KEY`, or the macOS keychain item `typesafe-api` |

You only need access to the trackers you actually use.

---

## do-shit

Takes GitHub issues, ClickUp tasks or Linear issues to merged PRs. Investigators plan each item, role-based subagent teams build and review in isolated worktrees, and a deterministic harness owns every loop decision. One PR per leaf item, merged in a safe order after you approve.

**Use it when** the tickets are well enough specified that an engineer could pick them up. **Skip it for** a one-file fix (just ask for it) or a task that still needs scoping (run [`quick-ask-me`](#quick-ask-me) first).

### Usage

```
/real-skills:do-shit <ref-or-url> [<more>…] [--dry-run]
/real-skills:do-shit resume <run-id>
/real-skills:do-shit status [<run-id>]
```

| Tracker | Accepted refs |
|---|---|
| GitHub Issues | `#12`, `12`, `owner/repo#12`, `https://github.com/owner/repo/issues/12` |
| ClickUp | `868abc123`, `CU-868abc123`, `https://app.clickup.com/t/868abc123` |
| Linear | `ENG-123`, `https://linear.app/<workspace>/issue/ENG-123/<slug>` |

- Run it from inside the target repo. One repo and one tracker per run.
- Parents expand into their sub-issues or subtasks. Each leaf gets its own PR.
- A bare `ABC-123` is read as Linear. ClickUp custom ids look the same, so pass the URL if that is what you mean.
- `--dry-run` runs the harness, agents, worktrees and scope checks for real. Pushes, PR creation, tracker writes and merges are logged instead of executed. Use it for a first run in a new repo.
- `status` with no id lists every run. The run id is printed once at the start.

### What happens

| # | Phase | What runs | You decide |
|---|---|---|---|
| 1 | Intake | Fetches the items and their children, moves them to In Progress | |
| 2 | Plan | One investigator per leaf validates the ticket against the code and writes a plan. An architect writes a shared contract when leaves share an interface | **Checkpoint:** plans, risks, roles, spawn estimate. Proceed, exclude items, add notes, or replan |
| 3 | Build and review | Per leaf, in its own worktree: build roles in order, then review roles. Blocking findings go back to a fix loop | |
| 4 | PR | One PR per leaf, rebased, labelled, linked to its ticket | |
| 5 | Merge | Gates on CI, then merges in dependency order and retargets stacked PRs | **Merge approval:** all green, none, or a hand-picked list |
| 6 | QA (optional) | A QA plan per item, executed in the browser with a screenshot per step. Evidence is posted to the ticket; failures become bug children | **QA approval:** whether to run it and against which environment. Production is never offered |
| 7 | Report | One row per leaf: PR, result, statuses, roles, and what a human should do next for anything not clean | Whether to run again on the filed bugs |

Every question during a run comes from the harness at one of these gates. Nothing is pushed or merged in between without one.

### Roles

Seventeen role agents ship with the plugin as `real-skills:<role>`. Three run on every item; the rest join when the plan, a path rule, or Jev says the item needs them.

| Stage | Role | Does | Edits code |
|---|---|---|---|
| Plan | `investigator` | Validates the ticket against the code, writes the plan and acceptance criteria. **Core** | No |
| Plan | `architect` | Writes the shared contract (types, API, schema) for leaves that share an interface | No |
| Build | `data-engineer` | Schema, migrations, RLS policies, seeds. Runs first | Yes |
| Build | `worker` | Implements the plan with tests alongside. **Core** | Yes |
| Build | `designer` | Visual and interaction layer of UI changes | Yes |
| Build | `content-creator` | UI copy, i18n keys, email text | Yes |
| Build | `observability-engineer` | Errors, events and logs for new flows and jobs | Yes |
| Build | `docs-writer` | Developer docs, README, ADRs | Yes |
| Build | `test-engineer` | Tests only, filling the gaps the plan names. Runs last | Yes |
| Review | `tester` | Re-derives acceptance criteria from the ticket and runs the gates, blind to builder self-reports. **Core** | No |
| Review | `auditor` | Repo standards and acceptance criteria | No |
| Review | `security-advisor` | Auth, payments, RLS, secrets, PII, deletion. Blocks on exploitable issues | No |
| Review | `accessibility-auditor` | WCAG 2.2 AA on UI diffs | No |
| Review | `performance-engineer` | N+1 queries, missing indexes, unbounded lists, bundle growth | No |
| Merge | `integrator` | Rebases, resolves conflicts, retargets stacked branches | Yes |
| QA | `qa-planner` | Numbered browser test steps from the criteria and the merged diff | No |
| QA | `qa-tester` | Executes the QA plan in the browser with screenshots | No |

Build roles run in the order listed. No role pushes, opens PRs, or writes to a tracker; only the orchestrator does.

**Overriding a role.** A same-name agent in `<repo>/.claude/agents/` or `~/.claude/agents/` replaces the bundled one. A prefixed repo agent (e.g. `acme-researcher` for `investigator`) is picked up too. Plugin agents can't declare hooks, but repo and user agents can: add the guard to their frontmatter if you want it.

### Safety

- **Role guard.** `hooks/hooks.json` runs `guard-roles.mjs` on Bash, Edit and Write calls. It acts only on `real-skills:<role>` agents: read-only roles can't edit or run mutating commands, build roles edit only inside `.claude/worktrees/ds-*` and their `allowed_paths`, and no role pushes or stashes. Your other agents are untouched.
- **Spawn cap.** The checkpoint shows the spawn estimate against the cap (default 60). The harness enforces it and finishes in-flight loops; a capped run is reported as partial.
- **Tracker statuses** only move forward. Items the run drops are restored to the status they had at the start, unless someone moved them since.
- **Pushes** to an existing PR branch use `--force-with-lease`, never a plain force.

### Configuration

Optional, in `<repo>/.claude/do-shit.json`. Every key is optional.

| Key | Default | Purpose |
|---|---|---|
| `verify` | The verify command in the repo's `CLAUDE.md` / `AGENTS.md` | Gate command every team runs |
| `base` | Remote default branch | Branch PRs target |
| `statuses` | Matched by status type | Tracker status names for `in_progress`, `review`, `qa`, `done`, `reopened` |
| `labels` | None | PR labels: `always`, `migration`, `destructive_migration` |
| `path_rules` | Built-in rules for auth, payments, migrations, i18n | `[{pattern, roles}]`. A regex match on a planned or changed file adds roles |
| `allowed_paths` | Each role's own frontmatter | `{role: [globs]}`. Where a build role may edit |
| `spawn_cap` | `60` | Maximum agent spawns per run |
| `max_concurrent_teams` | `3` | Teams building at once |
| `merge_method` | `squash` | Passed to `gh pr merge` |
| `pr_title` | `{title}` on GitHub, `[{ref}] {title}` on Linear, `{title} [{ref}]` on ClickUp | PR title template |

```json
{
  "verify": "pnpm check && pnpm test",
  "base": "main",
  "labels": { "always": ["agent"], "migration": ["has-migration"] },
  "path_rules": [{ "pattern": "^apps/billing/", "roles": ["security-advisor"] }],
  "allowed_paths": { "data-engineer": ["db/**", "supabase/migrations/**"] },
  "spawn_cap": 40
}
```

### Jev (optional)

[Jev](https://typesafe.ai) gives the harness typed judgments, such as which optional roles an item needs. Without a key the harness runs on conservative code rules.

| Mode | Behaviour |
|---|---|
| `shadow` | Jev is logged, code rules decide. The first 3 real runs stay here |
| `live` | Jev decides, within the code vetoes. Opt in once you have reviewed the shadow logs |
| `degraded` | The API failed, code rules decide |

Request bodies are redacted (`hooks/lib/redact.jq`) before they leave the machine and never include source code. The question catalog is in [`skills/do-shit/references/jev-questions.md`](skills/do-shit/references/jev-questions.md).

To calibrate, `skills/do-shit/scripts/eval/run.mjs` needs fixtures from your own PRs in `scripts/eval/fixtures/`. They are gitignored.

### Run state and resume

State lives in `~/.claude/state/do-shit/<run-id>/` (override with `DO_SHIT_STATE_DIR`): `run.json`, team state, `events.jsonl`, prompts and QA screenshots. Runs are resumable after a crash or a closed session: `resume` reconciles what already happened (agents still running, PRs opened, merges done) before it continues. Never edit the state files by hand.

---

## changelog

Turns the last N releases into a changelog a person can read: every PR each release carried, a one-or-two-sentence summary, its tracker ticket, then an "In progress" section of recently opened tickets.

**Read-only.** It never merges, promotes, tags, or writes to a tracker. The only files it writes are the changelog and, during setup, `.claude/changelog.json`.

### Usage

```
/real-skills:changelog [technical | non-technical] [--releases N] [--days N]
/real-skills:changelog setup
```

| Argument | Default | Meaning |
|---|---|---|
| `technical` \| `non-technical` | Asked if omitted | Audience. One per run |
| `--releases N` | `2` | How many releases back. `--promotions N` is an alias |
| `--days N` | `in_progress_days` from config, else `3` | Window for the In-progress section |
| `setup` | | Run or redo setup |

```
/real-skills:changelog non-technical --releases 3
```

### Audiences

The facts are identical; the prose changes. Migrations and default-on behaviour changes are called out for both.

| | Technical | Non-technical |
|---|---|---|
| Reader | Engineers | Ops, support, leadership |
| Leads with | Root cause | Effect on the people using the product |
| Includes | PR numbers, ticket IDs, migration filenames, flag names | Links only. No PR numbers, paths or flag names in the prose |

### Setup

Runs automatically on first use. It detects the release model, samples recent PRs to derive the ticket-ID pattern, asks which tracker you use, and writes `.claude/changelog.json`. Commit that file so teammates get the same setup.

| Release model | A release is… |
|---|---|
| `promotion` | A merged PR into the production branch. Identified by base branch, never by title |
| `tags` | A tag matching `tag_pattern` |

Trackers: GitHub Issues, ClickUp, Linear, none (PRs only), or any other tracker with an MCP connector (Jira, Asana, Shortcut, Notion…).

### Configuration

`<repo>/.claude/changelog.json`, written by setup. Full example: [`skills/changelog/config.example.json`](skills/changelog/config.example.json).

| Key | Purpose |
|---|---|
| `repo` | `owner/name` |
| `release.mode` | `promotion` or `tags` |
| `release.main_branch`, `release.production_branch`, `release.tag_pattern` | Where releases are read from |
| `tracker.type` | `github`, `clickup`, `linear`, `other`, `none` |
| `tracker.id_pattern`, `tracker.url_template` | How ticket IDs are recognised and linked |
| `in_progress_days` | Default window for the In-progress section |
| `areas` | Section headings to group entries under. Inferred per run when empty |
| `output_dir` | Default `docs/changelogs` |

### Output

`<output_dir>/<YYYY-MM-DD>-changelog.md`, grouped by area under each release.

- A PR with no ticket says "no ticket linked". The skill never attaches a ticket it found by searching.
- If the tracker is unreachable or rate-limited, the changelog says so and omits In progress rather than showing an empty list.
- It makes at most 6 tracker calls per run.
- If the clone is shallow, the script prints the `git fetch … --unshallow` command to run.

### Adding a tracker

Add `skills/changelog/references/trackers/<type>.md` with **Setup**, **Ticket ID** and **In progress** sections, then list it in `skills/changelog/references/setup.md`.

---

## quick-ask-me

A short interview for quick tasks. It pins down the objective and observable success criteria, asks only the questions that would change what gets built, and ends with a brief an implementation step can run from.

**User-invoked only.** The model never starts it on its own, and it never starts implementing.

### Usage

```
/real-skills:quick-ask-me [goal]
```

```
/real-skills:quick-ask-me add CSV export to the orders table
```

### What happens

1. **Objective.** "What's the main goal?" If you passed one, it restates it and asks you to confirm.
2. **Success criteria.** "How will we know it's done?" Every criterion must be observable: a test passes, a command prints X, a user can do Y. It proposes two to four.
3. **At most 6 more questions,** one at a time, each with a recommended answer. Facts it can look up in the repo are looked up, not asked.
4. **Brief.** Objective, success criteria, decisions, out of scope, and where the tests live. Printed in chat; saved to `docs/briefs/<slug>.md` only if you say yes.

It stops early once the objective is confirmed, the criteria are observable, the scope boundary is named, the test seam is known, and no term conflicts with `CONTEXT.md`. When the budget runs out it asks once: good enough to implement, or keep going?

### What it writes

| File | When |
|---|---|
| `CONTEXT.md` | The moment a term is resolved. Glossary only. Created on the first term |
| `docs/adr/000N-<slug>.md` | Only for a decision that is hard to reverse, surprising without context, and a real trade-off. Most runs write none |
| `docs/briefs/<slug>.md` | Only on request |

Formats: [`CONTEXT-FORMAT.md`](skills/quick-ask-me/references/CONTEXT-FORMAT.md), [`ADR-FORMAT.md`](skills/quick-ask-me/references/ADR-FORMAT.md).

---

## Repo layout

```
.claude-plugin/
  marketplace.json      marketplace "jpcasa-skills"
  plugin.json           plugin "real-skills" (root of this repo)
.codex-plugin/plugin.json             Codex plugin manifest
.agents/plugins/marketplace.json      Codex marketplace manifest
skills/                 each skill also has agents/openai.yaml (Codex display + invocation policy)
  do-shit/              orchestrator skill + harness (scripts/harness.mjs) + tracker adapters
  changelog/            skill + release-ranges.sh + tracker adapters
  quick-ask-me/         skill + CONTEXT/ADR formats
agents/                 17 do-shit role agents, spawned as real-skills:<role>
hooks/                  hooks.json + guard-roles.mjs + lib/redact.jq
```

## Develop

```bash
claude plugin validate . --strict
```

```bash
node --test skills/do-shit/scripts/test/*.test.mjs
```

```bash
bash skills/changelog/scripts/test/release-ranges.test.sh
```

**Adding a skill:** create `skills/<name>/SKILL.md` (frontmatter `name`, `description`, optional `argument-hint`) and `skills/<name>/agents/openai.yaml` for Codex, then add it to the tables at the top of this file and to the `description` in `.claude-plugin/plugin.json`.

## License

MIT. `skills/quick-ask-me` builds on [mattpocock/skills](https://github.com/mattpocock/skills) (MIT): its interview style follows `grill-with-docs`, and `references/CONTEXT-FORMAT.md` and `references/ADR-FORMAT.md` are adapted from `domain-modeling`.

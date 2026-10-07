# real-skills

Skills for everyday engineering work, packaged as one plugin. Install once, get every skill. Works in Claude Code and Codex (`do-shit` needs Claude Code).

## Which skill do I want?

| You want to… | Use | Writes to |
|---|---|---|
| Hand over tracker tickets and get reviewed, merged PRs back | [`do-shit`](#do-shit) | Branches, PRs, tracker statuses and comments (all behind approval gates) |
| Tell people what shipped in the last releases | [`changelog`](#changelog) | One Markdown file. Read-only everywhere else |
| Pin down a small task before building it | [`quick-ask-me`](#quick-ask-me) | `CONTEXT.md` terms, the occasional ADR |
| Turn an idea into a short spec an agent can implement from | [`ask-and-create-specs`](#ask-and-create-specs) | `docs/specs/`, `CONTEXT.md` terms |

**Contents:** [How these skills work](#how-these-skills-work) · [Install](#install) · [Requirements](#requirements) · [do-shit](#do-shit) · [changelog](#changelog) · [quick-ask-me](#quick-ask-me) · [ask-and-create-specs](#ask-and-create-specs) · [Repo layout](#repo-layout) · [Develop](#develop) · [License](#license)

## How these skills work

The skills are built the same way. Two ideas do the work.

**1. Agents report in compressed form.** A long run dies when the main conversation fills up with prose. `do-shit`, `changelog` and `quick-ask-me` carry the same short rule, [`report-style.md`](skills/do-shit/references/report-style.md), modelled on [caveman](https://github.com/JuliusBrussee/caveman): fragments, no filler, exact paths and error text. In `do-shit` the harness enforces it: a role's reply is a JSON block and nothing else, each field has a length cap, and an over-long report is sent back once. Nothing a teammate reads is compressed (PR bodies, tracker comments, changelogs, briefs), and security findings are always written in full. `ask-and-create-specs` applies the same idea to its output: the spec itself is terse and capped at 40 lines per file, because the reader is an implementing agent.

**2. Code decides; Jev judges; you are asked last.** Each skill has a script that owns its decisions. Where a decision needs judgment ("does this plan need a human to look at it?"), the script asks [Jev](https://typesafe.ai) a typed question and gets back a number. Code then applies a threshold and a list of vetoes. Jev never decides alone, and a veto always wins. You are asked only when a veto fires, Jev is unsure, or the step is one that stays yours.

| Skill | Script | Decided in code today | Jev judgments, logged until calibrated | Always yours |
|---|---|---|---|---|
| `do-shit` | `harness.mjs` | Every loop step, role scope, merge order, one architect retry, waiting on pending CI, post-QA offers from config | Passing the plan checkpoint, re-approving a fixed PR | Merge approval, QA environment and sign-in |
| `changelog` | `judge.mjs` | Which ticket is the PR's own, migration and docs-only flags, default audience from config | Ambiguous ticket IDs, default-on behaviour changes, product area | Nothing is written outside the changelog file |
| `quick-ask-me` | `gate.mjs` | The six-question budget, the five stop conditions | Which questions the repo can answer, which would not change the build, whether a criterion is checkable | Objective, success criteria, final confirmation |
| `ask-and-create-specs` | `spec-jev.mjs` | The 40-line cap, spec structure, thresholds | None logged-only: see the note below | Goal, the questions that reach you, the write-or-keep-going call |

**What "logged until calibrated" means.** A Jev question decides nothing until it has been checked against real examples. Ten questions are new and ship uncalibrated (two in `do-shit`, three in `changelog`, five in `quick-ask-me`): with a key set they are asked and their answers are written to a log next to what the code decided, and the skill still asks you as it did before. Turning one on is a one-line change after you have looked at that log. `do-shit`'s original questions (role choice, dependencies, loop decisions, the merge gate, QA failures) are calibrated and decide in `live` mode.

**`ask-and-create-specs` is the exception.** Its Jev answers decide straight away: which questions are asked, assumed or dropped, when the interview stops, one spec or slices, and which spec lines are flagged as dead. Its thresholds are uncalibrated defaults. What it assumed is printed in the spec under "Assumed" and in the handoff, so you can override it. `ASK_SPECS_JEV=0` turns Jev off and the skill judges by its written rules.

**Without a TypeSafe key** every skill still works: the code-only column applies, and everything else is asked or judged as before.

**What leaves your machine.** Only when a key is set, and only to `api.typesafe.ai`, after credential-shaped strings are redacted (`redact.jq`):

| Skill | Sent | Never sent |
|---|---|---|
| `do-shit` | Ticket titles and bodies, plan summaries, file paths, review findings, CI check names | Source code |
| `changelog` | PR titles, bodies, branch names, labels, file paths | File contents, diffs |
| `quick-ask-me` | Your objective, success criteria, drafted questions, facts looked up in the repo | File contents |
| `ask-and-create-specs` | The goal, drafted questions, the running brief, spec lines | Source code |

Turn it off per skill: unset the key, or `"jev": "off"` in `.claude/changelog.json`, or `QUICK_ASK_ME_JEV=off`, or `ASK_SPECS_JEV=0`.

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

This copies the skills into Codex's skills folder. Invoke them without the prefix: `/changelog`, `/quick-ask-me`, `/ask-and-create-specs`. The repo also ships Codex plugin manifests (`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`) for plugin-aware installs.

### Support

| Skill | Claude Code | Codex |
|---|---|---|
| `do-shit` | ✓ | ✗ Needs Claude Code subagents, plugin agents and hooks. Stops with a message elsewhere |
| `changelog` | ✓ | ✓ Tracker connectors must be configured in Codex too |
| `quick-ask-me` | ✓ | ✓ |
| `ask-and-create-specs` | ✓ | ✓ Jev needs the full plugin layout (it uses `do-shit`'s client); installed alone it follows its by-hand rules |

## Requirements

| Needed for | What |
|---|---|
| Everything | `git`, `gh` (authenticated) |
| `do-shit`, `changelog` | `jq` |
| `do-shit` | Node 20+ |
| `changelog`, `quick-ask-me`, `ask-and-create-specs` scripts | Node 20+. Without it the skills apply the same rules by hand |
| GitHub Issues | `gh` only |
| ClickUp | A ClickUp MCP connector, e.g. the claude.ai ClickUp connector |
| Linear | A Linear MCP connector. `do-shit` uses [Composio](https://composio.dev)'s `linear` toolkit |
| Jev (optional, all skills) | A [TypeSafe](https://typesafe.ai) API key in `TYPESAFE_API_KEY`, or the macOS keychain item `typesafe-api`. Also needs `jq` for redaction |

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
| 2 | Plan | One investigator per leaf validates the ticket against the code and writes a plan. An architect writes a shared contract when leaves share an interface (retried once on its own if it fails) | **Checkpoint:** plans, risks, roles, spawn estimate. Proceed, exclude items, add notes, or replan |
| 3 | Build and review | Per leaf, in its own worktree: build roles in order, then review roles. Blocking findings go back to a fix loop | |
| 4 | PR | One PR per leaf, rebased, labelled, linked to its ticket | |
| 5 | Merge | Gates on CI, then merges in dependency order and retargets stacked PRs. Waits for pending CI by itself (20 min by default), then skips the PR and reports it | **Merge approval:** all green, none, or a hand-picked list. **Re-approval** if a fix changed an approved PR |
| 6 | QA (optional) | A QA plan per item, executed in the browser with a screenshot per step. Evidence is posted to the ticket; failures become bug children | **QA approval:** whether to run it and against which environment. Production is never offered |
| 7 | Report | One row per leaf: PR, result, statuses, roles, what a human should do next for anything not clean, and every gate the harness decided without asking | Whether to run again on the filed bugs (or set `after_qa` and it is not asked) |

Every question during a run comes from the harness at one of these gates. Nothing is merged without the merge approval.

### Which gates can be decided for you

| Gate | Decided without asking when | Status |
|---|---|---|
| Architect failed | First failure: retried once | On |
| CI still pending | Inside `ci_wait_minutes`: keeps waiting. After: PR skipped and reported | On |
| Post-QA offers | The repo sets `after_qa` | On when configured |
| Checkpoint | `live` mode, no veto, Jev sees nothing for a person to review | Logged only, until calibrated |
| Re-approval | `live` mode, no veto, tester passed, Jev says the fix stayed inside the ticket | Logged only, until calibrated |
| Merge approval | Never | Always asked |
| QA environment | Never | Always asked |

A **veto** forces the question whatever Jev says. For the checkpoint: an open question in a plan, an excluded item, a security-sensitive area, a migration or schema file, a planner warning, a spawn estimate over the cap, a failed architect. For re-approval: the fix touched a file outside the plan (checked in git, not from the agent's report), a migration, a security finding, or a tester that did not pass.

When a gate does ask, it says why: the vetoes that fired, or that Jev was not allowed to decide. Every automatic decision is listed at merge approval, before anything merges, and again in the final report. Set `"autonomy": "off"` to be asked at every gate.

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
- **Report caps.** Role reports are JSON only, with length caps per field. An over-long report is sent back once and then accepted: length never fails a role. Security findings have no cap.
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
| `autonomy` | `"gates"` | `"off"` asks at every gate |
| `ci_wait_minutes` | `20` | How long to wait for pending CI before skipping a PR |
| `after_qa` | Not set: asked | `{fix_bugs, e2e}`. What to do after QA without asking |

```json
{
  "verify": "pnpm check && pnpm test",
  "base": "main",
  "labels": { "always": ["agent"], "migration": ["has-migration"] },
  "path_rules": [{ "pattern": "^apps/billing/", "roles": ["security-advisor"] }],
  "allowed_paths": { "data-engineer": ["db/**", "supabase/migrations/**"] },
  "spawn_cap": 40,
  "ci_wait_minutes": 30,
  "after_qa": { "fix_bugs": false, "e2e": false }
}
```

### Jev (optional)

[Jev](https://typesafe.ai) gives the harness typed judgments, such as which optional roles an item needs or whether a failure repeats the last one. Without a key the harness runs on conservative code rules.

| Mode | Behaviour |
|---|---|
| `shadow` | Jev is logged, code rules decide. The first 3 real runs stay here |
| `live` | Jev decides, within the code vetoes. Opt in once you have reviewed the shadow logs |
| `degraded` | The API failed, code rules decide |

Request bodies are redacted (`hooks/lib/redact.jq`) before they leave the machine and never include source code. The question catalog, with thresholds and which questions are still uncalibrated, is in [`skills/do-shit/references/jev-questions.md`](skills/do-shit/references/jev-questions.md).

A question listed there as uncalibrated is logged and decides nothing, in every mode. `events.jsonl` records each one as a `shadow_gate` event: what the harness would have decided, next to what you answered.

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
| `technical` \| `non-technical` | `default_audience` from config, else asked | Audience. One per run |
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
| `default_audience` | `technical` or `non-technical`. Set it and the audience is never asked |
| `jev` | `shadow` (default), `live` or `off`. See [How these skills work](#how-these-skills-work) |
| `in_progress_days` | Default window for the In-progress section |
| `areas` | Section headings to group entries under. Inferred per run when empty |
| `output_dir` | Default `docs/changelogs` |

### How tickets and flags are decided

`scripts/judge.mjs` decides these per PR, in code, before any sentence is written:

| Fact | Rule |
|---|---|
| The PR's own ticket | An ID in the branch name wins. Else the first ID the body declares (`Fixes …`, `Closes …`, `ClickUp: …`). Else none. On GitHub, the PR's closing reference comes first |
| Migration | A changed path is a migration or `.sql` file. The files are named |
| Docs only | Every changed path is documentation |

The script can only return a ticket ID that appears in the PR itself. When a body cites several IDs and declares none, the answer is "no ticket linked"; Jev's view on which one it is gets logged, and can fill that gap once the question is calibrated and `jev` is `live`. The same goes for default-on behaviour changes and product area, which the model judges from the PR body until then.

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
3. **At most 6 more questions,** one at a time, each with a recommended answer. It drafts the open questions first and passes them through `scripts/gate.mjs`, which holds the budget. Facts it can look up in the repo are looked up, not asked.
4. **Brief.** Objective, success criteria, decisions, out of scope, and where the tests live. Printed in chat; saved to `docs/briefs/<slug>.md` only if you say yes.

It stops early once the objective is confirmed, the criteria are observable, the scope boundary is named, the test seam is known, and no term conflicts with `CONTEXT.md`. The gate script checks those five in code after each answer. When the budget runs out it asks once: good enough to implement, or keep going?

With a TypeSafe key, the gate also asks Jev which drafted questions the repo could answer and which would not change what gets built. Those answers are logged for now; once calibrated they route a question to a lookup or drop it, and a dropped question shows up in the brief under "Assumed without asking" with the answer that was taken. The objective, the success criteria and the final confirmation always come from you.

### What it writes

| File | When |
|---|---|
| `CONTEXT.md` | The moment a term is resolved. Glossary only. Created on the first term |
| `docs/adr/000N-<slug>.md` | Only for a decision that is hard to reverse, surprising without context, and a real trade-off. Most runs write none |
| `docs/briefs/<slug>.md` | Only on request |

Formats: [`CONTEXT-FORMAT.md`](skills/quick-ask-me/references/CONTEXT-FORMAT.md), [`ADR-FORMAT.md`](skills/quick-ask-me/references/ADR-FORMAT.md).

---

## ask-and-create-specs

An interview that ends in a spec an implementing agent can run from. Long specs confuse the agent that reads them, so every line has to change what gets built or how it is checked. Specs are terse and hard-capped at 40 non-blank lines per file; bigger work becomes an index plus slices.

**User-invoked only.** It never starts implementing: it writes the spec, prints a handoff, and stops.

**Use it when** the work needs a written spec someone else (or a later session) will build from. For a small task where a brief in the conversation is enough, use [`quick-ask-me`](#quick-ask-me).

### Usage

```
/real-skills:ask-and-create-specs [goal]
```

### What happens

1. **Context.** Reads the relevant code, `CONTEXT.md`, existing specs and recent commits. A fact it can look up is never a question.
2. **Goal.** Restates the goal in one sentence and asks you to confirm or correct it.
3. **Interview rounds.** It lists every open question with a recommended answer, then triages them: **ask** (put to you, up to 4 at a time), **assume** (takes its recommendation and records it), or **drop**. After each round a gate checks whether the brief is complete. After 3 rounds without a stop it shows the brief and asks once: write the spec, or keep going?
4. **Shape.** One file, or an index plus slices that can each be implemented and verified alone. Optional sections (Data, UI, Interfaces, Rollout, Risks) appear only when the work touches them.
5. **Write, lint, save.** The spec is linted for the line cap, structure, uncheckable done-when items, dead lines and duplicates, with at most two fix passes.

### How it decides

`scripts/spec-jev.mjs` has four stateless commands. Code owns the thresholds; Jev supplies the scores.

| Command | Decides |
|---|---|
| `triage` | Ask, assume or drop, per question |
| `gate` | Whether to stop interviewing, and what the brief still lacks |
| `shape` | Single spec or slices, and which optional sections |
| `lint` | Line cap and structure (no Jev needed), dead and duplicate lines |

Unlike the other skills, these Jev answers take effect immediately and the thresholds are uncalibrated defaults. Everything it assumed is listed in the spec and the handoff. When Jev is unavailable (`degraded`), the skill follows the "By hand" rule written for each step, with a hard cap of 6 questions after the goal.

### Output

| File | When |
|---|---|
| `docs/specs/YYYY-MM-DD-<slug>.md` | Single spec. Uses the repo's own spec location if it has one |
| `docs/specs/YYYY-MM-DD-<slug>/README.md` + `NN-<slice>.md` | Sliced spec |
| `CONTEXT.md` | Glossary terms, the moment they resolve |

Every spec has Goal, Done when (checkboxes), Out of scope and Seam; Decisions and Assumed when there are any. `## Risks` lines and anything where word order matters are written in full sentences. The handoff reports how many questions were asked, assumed and dropped, the assumptions to override, and any lint problem left.

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
  changelog/            skill + release-ranges.sh + judge.mjs + tracker adapters
  quick-ask-me/         skill + gate.mjs + CONTEXT/ADR formats
  ask-and-create-specs/ skill + spec-jev.mjs (reuses do-shit's Jev client)
                        do-shit, changelog, quick-ask-me: references/report-style.md; changelog and
                        quick-ask-me carry their own scripts/lib/jev.mjs + redact.jq (kept identical by a test)
agents/                 17 do-shit role agents, spawned as real-skills:<role>
hooks/                  hooks.json + guard-roles.mjs + lib/redact.jq
```

## Develop

```bash
claude plugin validate . --strict
```

```bash
node --test skills/*/scripts/test/*.test.mjs
```

```bash
bash skills/changelog/scripts/test/release-ranges.test.sh
```

**Copied files.** `changelog` and `quick-ask-me` must work when installed as a single folder, so they carry copies of `jev.mjs`, `redact.jq` and `report-style.md`. Edit the source (`skills/do-shit/scripts/lib/jev.mjs`, `hooks/lib/redact.jq`, `skills/do-shit/references/report-style.md`), copy it over the others, and `sync.test.mjs` confirms they match.

**Calibrating a Jev question.** `do-shit`, `changelog` and `quick-ask-me` list their unproven questions in an `UNCALIBRATED` set. Collect examples from the logs (`events.jsonl` for `do-shit`, `~/.claude/state/<skill>/jev.jsonl` for the other two), check the answers against what was right, set the threshold, then remove the id from the set.

**Adding a skill:** create `skills/<name>/SKILL.md` (frontmatter `name`, `description`, optional `argument-hint`) and `skills/<name>/agents/openai.yaml` for Codex, then add it to the tables at the top of this file and to the `description` in `.claude-plugin/plugin.json`.

## License

MIT. `skills/quick-ask-me` and `skills/ask-and-create-specs` build on [mattpocock/skills](https://github.com/mattpocock/skills) (MIT): their interview style follows `grill-with-docs`, the glossary format follows `domain-modeling`, and `references/CONTEXT-FORMAT.md` and `references/ADR-FORMAT.md` are adapted from `domain-modeling`.

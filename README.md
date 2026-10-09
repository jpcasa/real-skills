# real-skills

Skills for everyday engineering work, packaged as one plugin. Install once, get every skill. Works in Claude Code and Codex (`do-shit` needs Claude Code).

## Which skill do I want?

| Skill | What it does | You give it | You get back |
|---|---|---|---|
| [`wtf`](#wtf) | **Tells you what a bug report really is.** Checks if it was reported or fixed before, reads the code, and gives one verdict: user error, real bug, feature request, already fixed, already known. | A ticket link, a support conversation, or pasted text and screenshots | A verdict with evidence, written for engineers or for the customer. It changes nothing |
| [`quick-ask-me`](#quick-ask-me) | **Interviews you before a small task.** Goal, success criteria, then at most 6 more questions. | A goal, then your answers | A brief in the chat, glossary terms in `CONTEXT.md` |
| [`ask-and-create-specs`](#ask-and-create-specs) | **Interviews you, then writes a spec** an agent can build from. At most 40 lines per file. | A goal, then your answers | A spec in `docs/specs/`, glossary terms in `CONTEXT.md` |
| [`do-shit`](#do-shit) | **Builds your tickets.** Plans each one, runs agent teams that write and review the code, opens one PR per ticket, and merges after you approve. | Ticket refs from GitHub, ClickUp or Linear | Merged PRs, updated tickets, optional QA evidence |
| [`improve-design`](#improve-design) | **Improves one screen and proves each change.** Critiques it with impeccable's rubrics, applies small design moves one at a time, and keeps only the ones a blind before-and-after comparison and the repo's checks approve. | A route, or a file with `--route` | A pull request with one commit per kept change and the evidence in its description. It merges nothing |
| [`review-prs`](#review-prs) | **Reviews pull requests.** Reviewers read each PR through lenses, a script checks every finding against the code, and a second reviewer tries to disprove the bugs. Posts only if you say so. | PR numbers or URLs, or nothing for the PRs waiting on you | Findings per PR with a verdict. On approval, one comment review on GitHub |
| [`qa-this`](#qa-this) | **QAs finished work off production.** Picks the methods that fit each item (the repo's tests, new tests, a browser walkthrough, read-only database queries, requests), runs them, and computes a status from what it recorded. | Tickets, PRs, a branch, or a description. Or nothing: it asks | A short evidence comment on each ticket or PR, one report file, new test files left uncommitted. It fixes nothing and files nothing |
| [`check-infra-and-migrations`](#check-infra-and-migrations) | **Says whether a release is safe to push.** Classifies every migration statement and infrastructure change in a PR or promotion, checks the migration history, can read the real target (applied migrations, table sizes, an IaC plan), and gives a verdict and a runbook. | A PR, `promotion`, or `<base>..<head>`. Or nothing: the current branch's PR | A verdict and a runbook in the chat, one PR comment if you say so. It applies, deploys and merges nothing |
| [`changelog`](#changelog) | **Writes your release notes.** Finds every PR in the last releases, summarises each one, and links its ticket. | Nothing required. It reads the repo and your tracker | One Markdown file. It changes nothing else |
| [`calibrate`](#calibrate) | **Lets the Jev questions earn the right to decide.** The other skills log Jev's answers without acting on most of them. This checks those answers against what was right and switches on the ones that pass. | Nothing, or your Yes / No on past cases | A progress line per question. One local file changes, after you approve each question |
| [`handoff-with-prompt`](#handoff-with-prompt) | **Hands the task to the next agent.** Writes down where the work stands, then gives you a prompt to paste into a fresh session. | Nothing, or a note on why you are stopping | A handoff file in `~/.claude/handoffs/` and a prompt to copy. It changes nothing else |

The table follows a piece of work from report to release. `wtf` is where a bug report starts; new work starts at an interview. `quick-ask-me` and `ask-and-create-specs` are alternatives: the first for a small task, the second when an agent will build from a written spec. `improve-design` is the other builder: where `do-shit` builds a ticket, it takes a screen that already exists and makes it better. `review-prs` comes after the build: for PRs `do-shit` or `improve-design` opened, or anyone's. `qa-this` checks the result on a running environment before it is released, and `check-infra-and-migrations` is the last look at what a release does to the database and the infrastructure before it is pushed. The last two sit outside the flow: `calibrate` tunes the nine above it, and `handoff-with-prompt` is for whenever you stop mid-task and another agent picks it up.

### Two pillars under most of them

| Pillar | What it is | What it does here |
|---|---|---|
| **[Caveman](https://github.com/JuliusBrussee/caveman)** | A terse way of writing: fragments, no filler, exact paths and error text | Agents hand back short, structured reports, so a long run does not fill the context with prose. `do-shit` enforces it: role reports are JSON only, with length caps. `ask-and-create-specs` writes its specs this way, `wtf` its engineer-facing reports, and `review-prs` its reviewers' findings. Anything a teammate or customer reads, and every security finding, stays in full sentences |
| **[Jev](https://typesafe.ai)** | A judgment model: you ask a typed question, it answers with a probability | Each skill has a script that makes its decisions in code and asks Jev for the judgment calls. Code applies thresholds and vetoes, so you are asked less. A new question is logged first and decides only once it is calibrated. Optional: with no key the skills run on their code rules |

`handoff-with-prompt` uses neither: it has no script and asks Jev nothing. More in [How these skills work](#how-these-skills-work).

**Contents:** [How these skills work](#how-these-skills-work) · [Install](#install) · [Requirements](#requirements) · [wtf](#wtf) · [quick-ask-me](#quick-ask-me) · [ask-and-create-specs](#ask-and-create-specs) · [do-shit](#do-shit) · [improve-design](#improve-design) · [review-prs](#review-prs) · [qa-this](#qa-this) · [check-infra-and-migrations](#check-infra-and-migrations) · [changelog](#changelog) · [calibrate](#calibrate) · [handoff-with-prompt](#handoff-with-prompt) · [Repo layout](#repo-layout) · [Develop](#develop) · [License](#license)

## How these skills work

The skills are built the same way, on two pillars. The exception is `handoff-with-prompt`, which is plain instructions: no script, no Jev.

**1. Caveman: agents report in compressed form.** A long run dies when the main conversation fills up with prose. `do-shit`, `improve-design`, `changelog`, `quick-ask-me`, `wtf`, `review-prs`, `qa-this` and `check-infra-and-migrations` carry the same short rule, [`report-style.md`](skills/do-shit/references/report-style.md), modelled on [caveman](https://github.com/JuliusBrussee/caveman): fragments, no filler, exact paths and error text. In `do-shit` the harness enforces it: a role's reply is a JSON block and nothing else, each field has a length cap, and an over-long report is sent back once. Nothing a teammate reads is compressed (PR bodies, tracker comments, changelogs, briefs), and security findings are always written in full. `ask-and-create-specs` applies the same idea to its output: the spec itself is terse and capped at 40 lines per file, because the reader is an implementing agent.

**2. Jev: code decides, Jev judges, you are asked last.** Each skill has a script that owns its decisions. Where a decision needs judgment ("does this plan need a human to look at it?"), the script asks [Jev](https://typesafe.ai) a typed question and gets back a number. Code then applies a threshold and a list of vetoes. Jev never decides alone, and a veto always wins. You are asked only when a veto fires, Jev is unsure, or the step is one that stays yours.

| Skill | Script | Decided in code today | Jev judgments, logged until calibrated | Always yours |
|---|---|---|---|---|
| `wtf` | `wtf.mjs` | Whether each `file:line` citation is real, whether a fix is live where the report came from, whether the evidence supports the verdict, confidence, budgets | Same issue as a prior ticket, request or breakage, did the screen say enough | Whether to reproduce, and on which environment |
| `quick-ask-me` | `gate.mjs` | The six-question budget, the five stop conditions | Which questions the repo can answer, which would not change the build, whether a criterion is checkable | Objective, success criteria, final confirmation |
| `ask-and-create-specs` | `spec-jev.mjs` | The 40-line cap, spec structure, missing brief fields | Ask / assume / drop per question, when to stop, one spec or slices, dead and duplicate lines | Goal, the write-or-keep-going call |
| `do-shit` | `harness.mjs` | Every loop step, role scope, merge order, one architect retry, waiting on pending CI, post-QA offers from config | Passing the plan checkpoint, re-approving a fixed PR | Merge approval, QA environment and sign-in |
| `improve-design` | `improve.mjs` | Which issues become moves and in what order, that a direction change is never ticked for you, whether each move stayed in scope, kept the gates green and added no detector finding, which picture is which in the blind comparison, whether a move stays, the verdict, draft or ready, the pull-request text | Whether a move is worth making, whether it changes the look as a whole, whether a direction change is needed, whether the critic's second-choice command fits better, whether the result is an improvement, whether it harmed something else. Switched on, they cut, reclassify, swap and drop; the only thing one can add is a tick on a direction change the critic proposed | Which moves run, pictures in the pull request, the merge |
| `review-prs` | `review.mjs` | Which findings are real (citation check), duplicates, what was already raised, when a refutation counts, the nit budget, the verdict, the review payload | An extra lens, whether a nit is worth showing, two findings making one point, a PR doing more than it says | Which PRs to post to. It never approves or merges |
| `qa-this` | `qa.mjs` | Which methods run, that every criterion has a check, every test, query and request result, whether only test files changed, the status of each item, the comment text, production refused | Whether an item needs a browser check, a data check or new tests, whether a check covers its criterion, whether a failure is the environment's | What to QA, the environment, accepting data changes, sign-in, what gets posted |
| `check-infra-and-migrations` | `check.mjs` | What every SQL statement and infrastructure change is, whether the migration history still applies, what is pending and how big the tables are (from your read-only commands), whether each of the agent's citations is real, the verdict, the runbook, the comment text | Whether a change destroys data, breaks running code or disrupts a service, whether a manual step is needed, whether it is safe to push. Even switched on, an answer can only make the verdict worse | Whether to read a live environment, whether to post, whether to push |
| `changelog` | `judge.mjs` | Which ticket is the PR's own, migration and docs-only flags, default audience from config | Ambiguous ticket IDs, default-on behaviour changes, product area | Nothing is written outside the changelog file |

**What "logged until calibrated" means.** A Jev question decides nothing until it has been checked against real examples. Outside `do-shit`'s original set, every question ships uncalibrated (two more in `do-shit`, three in `changelog`, five in `quick-ask-me`, three in `wtf`, four in `review-prs`, five in `qa-this`, five in `check-infra-and-migrations`, six in `improve-design`, and all ten thresholds in `ask-and-create-specs`): with a key set they are asked and their answers are written to a log next to what the code decided, and the skill still asks you as it did before. Turning one on is [`/real-skills:calibrate`](#calibrate)'s job: it measures each question against a fixed bar and, with your approval, lets it decide on your machine. `do-shit`'s original questions (role choice, dependencies, loop decisions, the merge gate, QA failures) are calibrated and decide in `live` mode.

**Without a TypeSafe key** every skill still works: the code-only column applies, and everything else is asked or judged as before.

**What leaves your machine.** Only when a key is set, and only to `api.typesafe.ai`, after credential-shaped strings are redacted (`redact.jq`):

| Skill | Sent | Never sent |
|---|---|---|
| `wtf` | A one-line symptom summary written without names, the expected and actual lines, prior-ticket titles. Emails, phone numbers and long numbers are stripped as well | The report, the support thread, screenshots, customer or company names, file contents |
| `quick-ask-me` | Your objective, success criteria, drafted questions, facts looked up in the repo | File contents |
| `ask-and-create-specs` | The goal, drafted questions, the running brief, spec lines | Source code |
| `do-shit` | Ticket titles and bodies, plan summaries, file paths, review findings, CI check names | Source code |
| `improve-design` | The critic's one-line problem and intent per move, command names, file paths, the three weakest heuristics with their scores, detector counts, one line per picture on what it shows | Pictures, the diff, source text, URL query strings |
| `review-prs` | PR title and body, changed file paths, each finding's one-line problem | The diff, quoted lines, source |
| `qa-this` | Item title, criteria lines, changed file paths, one line per check | Diff and source text, command output, row values, screenshots, URL query strings |
| `check-infra-and-migrations` | The title of the change, bucketed file paths, one normalized line per statement or infrastructure hit (keywords and identifiers, every literal replaced by `?`), rule names, when migrations run | Full files, diff hunks, literals, plan and query output, row counts, host names |
| `changelog` | PR titles, bodies, branch names, labels, file paths | File contents, diffs |

Turn it off per skill: unset the key, or `"jev": "off"` in `.claude/changelog.json`, or `QUICK_ASK_ME_JEV=off`, or `ASK_SPECS_JEV=0`, or `"jev": "off"` in `.claude/wtf.json`, or `REVIEW_PRS_JEV=off`, or `QA_THIS_JEV=off`, or `CHECK_INFRA_JEV=off`, or `IMPROVE_DESIGN_JEV=off`. The logs live in `~/.claude/state/<skill>/` (`events.jsonl` per run for `do-shit`, `jev.jsonl` for the others, `log.jsonl` for `wtf`). `REAL_SKILLS_CALIBRATION=off` makes every skill ignore what [`calibrate`](#calibrate) switched on.

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

This copies the skills into Codex's skills folder. Invoke them without the prefix: `/changelog`, `/quick-ask-me`, `/ask-and-create-specs`, `/wtf`, `/qa-this`, `/check-infra-and-migrations`, `/calibrate`, `/handoff-with-prompt`. The repo also ships Codex plugin manifests (`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`) for plugin-aware installs.

### Support

| Skill | Claude Code | Codex |
|---|---|---|
| `wtf` | ✓ | ✓ Everything except reproduction, which needs Claude Code's browser and the plugin's `qa-tester` agent |
| `quick-ask-me` | ✓ | ✓ |
| `ask-and-create-specs` | ✓ | ✓ Jev needs the full plugin layout (it uses `do-shit`'s client); installed alone it follows its by-hand rules |
| `do-shit` | ✓ | ✗ Needs Claude Code subagents, plugin agents and hooks. Stops with a message elsewhere |
| `improve-design` | ✓ Needs the [impeccable](https://impeccable.style) plugin | ✗ Needs Claude Code subagents and the plugin's `designer` and `design-critic` agents |
| `review-prs` | ✓ | ✓ One pass per lens by hand, no refuter: the report says the bugs are unrefuted |
| `qa-this` | ✓ | ✓ Everything except the browser walkthrough, which needs Claude Code's browser and the plugin's `qa-tester` agent. An existing Playwright or Cypress suite still runs |
| `check-infra-and-migrations` | ✓ | ✓ |
| `changelog` | ✓ | ✓ Tracker connectors must be configured in Codex too |
| `calibrate` | ✓ | ✓ |
| `handoff-with-prompt` | ✓ | ✓ |

## Requirements

| Needed for | What |
|---|---|
| Everything | `git`, `gh` (authenticated) |
| `do-shit`, `changelog` | `jq` |
| `improve-design` | Node 20+, `jq`, and the impeccable plugin (its detector and its rubrics). For pictures: the repo's Playwright, a Chrome on the machine, or Claude Code's browser. Without any, a run is code-only and its pull request is a draft |
| `do-shit`, `review-prs`, `qa-this`, `check-infra-and-migrations` | Node 20+. `qa-this` and `check-infra-and-migrations` also need `jq` to post a comment: one that cannot be redacted is not sent. `check-infra-and-migrations` needs `gh` only for pull requests; a commit range works without it |
| `changelog`, `quick-ask-me`, `ask-and-create-specs`, `wtf`, `calibrate` scripts | Node 20+ (`calibrate` has no by-hand mode). Without it the skills apply the same rules by hand, and `wtf` reports that nothing was machine-checked |
| GitHub Issues | `gh` only |
| ClickUp | A ClickUp MCP connector, e.g. the claude.ai ClickUp connector |
| Linear | A Linear MCP connector. `do-shit` uses [Composio](https://composio.dev)'s `linear` toolkit |
| Jev (optional, all skills) | A [TypeSafe](https://typesafe.ai) API key in `TYPESAFE_API_KEY`, or the macOS keychain item `typesafe-api`. Also needs `jq` for redaction |

You only need access to the trackers you actually use.

---

## wtf

Read-only triage of a bug report. Give it a ticket link, a support conversation, or pasted text and screenshots, and it tells you what actually happened: whether anyone reported it before, whether it is already fixed, and whether it is the user's mistake or the product's.

**It changes nothing.** No ticket, no comment, no reply, no file edit, nothing on production. For a real bug it prints a ticket draft and the next command, and stops.

**Use it when** a report lands and you need to decide whether to escalate. To build the fix afterwards, hand the ticket to [`do-shit`](#do-shit).

### Usage

```
/real-skills:wtf [<ticket-id|url> | <inbox-url> | <text and screenshot paths>] [--tech | --plain]
/real-skills:wtf latest [N]
/real-skills:wtf outcome <run-id> right|wrong [VERDICT]
/real-skills:wtf stats
/real-skills:wtf setup
```

```
/real-skills:wtf https://app.clickup.com/t/86abc1234 ~/Desktop/shot.png "happens only for managers" --plain
```

- Mixed input is the best case: a link, screenshots and a sentence of context are merged into one report.
- `--tech` writes for engineers: `file:line`, exact error strings, terse. `--plain` writes for support, ops or the customer: on-screen labels, numbered steps, no jargon. With neither, it investigates first and asks just before writing.
- `latest` triages the newest reports in one line each, from prior art alone.

### Verdicts

| Verdict | Means | What you do next |
|---|---|---|
| `USER_ERROR` | The product did what it was built to do | Send the steps. No ticket |
| `DEFECT` | Designed and observed behaviour differ | File the draft, or run `do-shit` on the ticket |
| `FEATURE_REQUEST` | The behaviour was never built | A product decision |
| `ALREADY_FIXED` | Fixed, but not yet released where they hit it | Tell them which release |
| `KNOWN` | An existing ticket or decision covers it | Link it. Do not open another |
| `INSUFFICIENT_INFO` | One specific fact is missing | Ask the named person for it |

A split is allowed where it is true: `USER_ERROR` on the logic and `DEFECT` on the messaging, for a block that was correct and explained nothing.

### What happens

1. **Normalize.** One record from whatever came in: what they did, expected and saw, when, who, which environment.
2. **Prior art first.** The tracker (open and closed), the session's memory and notes, git history and PRs. A direct hit ends the run here.
3. **Code path.** Reads the code that governs the behaviour and cites it.
4. **Runtime evidence** (optional). Sentry, PostHog or logs, 30 minutes either side of the reported time. It supplies error strings and corroboration. It never decides.
5. **Reproduction** (optional, Claude Code only). You are always asked first, and told it can change data in the environment you pick. It never runs on production.
6. **Verdict and report**, in the register you chose.

### What the script checks

The skill's promises are enforced by `scripts/wtf.mjs`, not left to the model.

| Promise | Check |
|---|---|
| Every claim cites `file:line` | The file exists, the line is in range, and the quoted text is really there. A citation that fails does not count |
| "Already fixed" | Pure git: is the fix merged, and is it in the environment the report came from? If it is already live there, the verdict is refused |
| One defensible verdict | Each verdict has required evidence and vetoes. An unsupported one becomes `INSUFFICIENT_INFO`, with what is missing |
| `USER_ERROR` is hard to reach | Needs a verified citation of the guard or designed behaviour, and steps to do instead. Ruled out by a control that renders enabled and does nothing, wrong data shown, a save that silently did not store, "it worked last week", or a faithful reproduction |
| Confidence | Computed: `high` needs verified code evidence plus a second source (prior art, a reproduction, or a runtime error that matches the code) |
| Budgets | 5 tracker reads, 4 runtime reads, 1 reproduction per run |
| No reproduction on production | Refused for any production host, and refused everywhere until `production_hosts` is configured |

The verdict step re-checks what it is told: it re-verifies citations, recomputes the deploy state from git, and reads the reproduction from its own record.

A citation check proves the line exists and says what was quoted. It does not prove the interpretation, so reports say "verified to exist".

### Learning whether it was right

Each report ends with a run id. When you find out how it went:

```
/real-skills:wtf outcome wtf-20261007-1412-a3f9 wrong DEFECT
```

`/real-skills:wtf stats` then shows accuracy per verdict and what the wrong ones turned out to be. The log (`~/.claude/state/wtf/log.jsonl`) holds verdicts and counts, never report text. These records are also what will calibrate its Jev questions.

### Configuration

`<repo>/.claude/wtf.json`, one per repo, because every repo keeps its bugs and runs somewhere different: one is ClickUp and AWS, the next is Linear and Render. **The first run in a repo asks**, once: `wtf.mjs probe` reads the repo's file names, dependency names, branch names and commit subjects to guess the tracker, the host and the monitoring, and the skill asks one round of questions with those guesses as the recommended answers. "None" is a valid answer and is written down. Commit the file and teammates are not asked. Change it any time with `/real-skills:wtf setup`. It holds no secrets. Full example: [`skills/wtf/config.example.json`](skills/wtf/config.example.json).

| Key | Purpose |
|---|---|
| `tracker` | `github`, `clickup`, `linear`, `other`, `none`, with the ticket-ID pattern and URL template |
| `inbox` | Optional support desk, by the URL shape of one conversation. Read through your own browser session |
| `release` | How releases work. Read from `.claude/changelog.json` when that exists |
| `environments` | Non-production environments reproduction may use: `name`, `kind` (`local`, `preview`, `staging`), `base_url` |
| `production_hosts` | Every production host. Reproduction is refused until this is set |
| `hosting` | Where the app runs: `aws`, `render`, `vercel`, `fly`, `netlify`, `heroku`, `railway`, `cloudflare`, `gcp`, `azure`, `other`, with the service to look at and the read-only way to get its logs and what is deployed |
| `runtime` | Optional `sentry`, `posthog`, `logs` |
| `heuristics` | Optional file with this product's own traps: which guards people misread, which screens hide prerequisites |
| `default_register` | `tech` or `plain`. Leave out to be asked |
| `jev` | `shadow` (default), `live`, `off` |

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
3. **Interview rounds.** It lists every open question with a recommended answer, then triages them: **ask** (put to you, up to 4 at a time), **assume** (takes its recommendation and records it), or **drop**. After each round a gate checks whether the brief is complete. After 3 rounds without a stop it shows the brief and asks once: write the spec, or keep going? Hard cap: 6 questions after the goal.
4. **Shape.** One file, or an index plus slices that can each be implemented and verified alone. Optional sections (Data, UI, Interfaces, Rollout, Risks) appear only when the work touches them.
5. **Write, lint, save.** The spec is linted for the line cap, structure, uncheckable done-when items, dead lines and duplicates, with at most two fix passes.

### How it decides

`scripts/spec-jev.mjs` has four stateless commands. Code owns the thresholds; Jev supplies the scores.

| Command | Decided in code, always | Judged by Jev |
|---|---|---|
| `triage` | | Ask, assume or drop, per question |
| `gate` | A brief with an empty goal, done-when, out-of-scope or seam does not stop | Whether each of those is good enough, and whether an approach is still undecided |
| `shape` | | Single spec or slices, and which optional sections |
| `lint` | Line cap, required sections, line length, checkbox format | Dead lines, duplicates, uncheckable done-when items |

Every threshold is uncalibrated, so today the Jev column is logged and decides nothing: each result says `by_hand: true` and carries a `shadow` field with what the scores would have chosen. The skill then follows the "By hand" rule written for each step, which is also what it does with no key. Everything it assumed is listed in the spec and the handoff.

| `ASK_SPECS_JEV` | Behaviour |
|---|---|
| unset | `shadow`: Jev is asked and logged; the By hand rules decide |
| `live` | Calibrated thresholds decide. None are calibrated yet, so this changes nothing until one is |
| `0` or `off` | Jev is never called |

### Output

| File | When |
|---|---|
| `docs/specs/YYYY-MM-DD-<slug>.md` | Single spec. Uses the repo's own spec location if it has one |
| `docs/specs/YYYY-MM-DD-<slug>/README.md` + `NN-<slice>.md` | Sliced spec |
| `CONTEXT.md` | Glossary terms, the moment they resolve |

Every spec has Goal, Done when (checkboxes), Out of scope and Seam; Decisions and Assumed when there are any. `## Risks` lines and anything where word order matters are written in full sentences. The handoff reports how many questions were asked, assumed and dropped, the assumptions to override, and any lint problem left.

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
| `max_concurrent_teams` | `3` | Teams building at once. Raise it for wide runs; Claude Code allows 20 concurrent subagents per session |
| `plan_workflow` | `false` | `true` runs the plan-phase investigators as one [dynamic workflow](https://code.claude.com/docs/en/workflows) instead of one background agent each. See [Plan workflow](#plan-workflow-opt-in) |
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

### Plan workflow (opt-in)

By default the orchestrator spawns one background agent per ticket to plan it, and records each report in its own turn. With `"plan_workflow": true`, a run that plans two or more tickets hands them to one workflow script (`skills/do-shit/workflows/plan.js`) and records every report in one `record-batch` call. The harness still decides everything: the script only fans out and returns.

- **Same agents, same guard.** The script spawns the same `real-skills:investigator` agents, so the role guard applies to them as before.
- **Reports are schema-checked** by the workflow runtime, which retries a malformed one. A report that is still missing or invalid sends that ticket back to a normal spawn; it does not fail the role.
- **Fallback.** If workflows are off or you decline the run, every ticket falls back to a normal spawn.
- **What you give up.** A workflow agent cannot be messaged afterwards, so a replan starts a fresh investigator instead of continuing the first one. An over-long report is accepted without the one re-ask. Claude Code asks you to approve the workflow on each run unless your permission mode skips that.
- **Scope.** Planning only. The architect, build, review, merge and QA stages run as before.

It needs Claude Code with dynamic workflows available (`/config`).

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

## improve-design

A design pass on one screen that already exists. It critiques the screen, turns the issues into small moves, makes them one at a time, and keeps a move only when a reviewer who does not know which version is newer prefers it and the repo's own checks still pass. It ends in a pull request that shows what stayed, what was taken back out, and why.

**It never touches production, never merges or approves, never pushes to a branch it did not create, and never changes logic.** It writes one worktree, one branch, one commit per kept move, one push and one pull request.

It is built on the [impeccable](https://impeccable.style) skill, which must be installed: impeccable supplies the rubrics, the commands and the detector; this skill supplies the loop that decides what stays.

**Use it when** a screen works but looks or reads worse than it should. For a new screen use impeccable itself; for a review with no changes, `/impeccable critique`.

### Usage

```
/real-skills:improve-design <route|file> [--route <path>] [--base <branch> | --pr <n>] [--direction <command>] [--max-moves <n>] [--auto] [--no-pr] [--screenshots]
/real-skills:improve-design setup
/real-skills:improve-design outcome <run-id> [<move> right|wrong]
/real-skills:improve-design stats
```

```
/real-skills:improve-design /settings/billing
/real-skills:improve-design src/app/pricing/page.tsx --route /pricing --direction bolder
/real-skills:improve-design /dashboard --pr 412 --max-moves 3
```

One screen per run. A route is a plain path; a query string is dropped. `--pr` stacks the work on that pull request's branch. `--direction` asks for one impeccable command by name. `--auto` skips the one question.

### What happens

1. **Its own copy.** A new worktree and branch from the base, the env files you named copied in, an install, and the run's own dev server on its own port. A server you already have running serves another tree and is never used.
2. **Baseline.** impeccable's detector runs on the screen's source. The script takes pictures at each viewport. A critic scores the screen on Nielsen's ten heuristics and impeccable's five audit dimensions, and lists its issues.
3. **Plan.** Each issue becomes a move: one element, one impeccable command, one line of intent. The script merges, ranks and cuts them.
4. **One question.** The scores, the moves in the order they would run, and what it will cost. You pick the moves, and say whether pictures go into the pull request.
5. **One move at a time.** The `designer` agent makes the change and commits. The script checks it, takes new pictures, and has a fresh critic compare before and after as `X` and `Y`. Kept, or taken off the branch with its patch saved. The next move starts from what was kept.
6. **Verdict.** A critic who knows nothing of the first score scores the result. The script computes the verdict.
7. **Pull request.** Pushed and opened, ready or draft by verdict.

### Two kinds of move

| Kind | Commands | At the question | Under `--auto` |
|---|---|---|---|
| Refine | `polish`, `layout`, `typeset`, `clarify`, `distill`, `harden`, `adapt`, `optimize`, `onboard` | Ticked | Runs |
| Direction change | `bolder`, `quieter`, `colorize`, `animate`, `delight`, `overdrive` | Listed, not ticked | Skipped and listed |

Any impeccable command can be proposed. A change of direction is yours to say yes to: tick it, or ask for it with `--direction`.

### What keeps a move, and what drops it

| Dropped when | Decided by |
|---|---|
| The commit touches a file outside `ui_paths` | Script |
| A gate that was green before the move is red after it | Script, by running your gate commands |
| impeccable's detector reports a finding that was not there before | Script, by scanning the changed files as they were and as they are |
| The designer committed nothing, or left work uncommitted | Script |
| The pictures are byte for byte the same | Script |
| The critic preferred the screen before the move at any viewport, or named something broken and where | A critic shown `X` and `Y` under neutral names; the script holds the key |
| A move with nothing to see, and no line of code shows its problem gone | Script, checking the critic's `path:line` |

The first four are vetoes: nothing overrides them. A move's work is never lost: its patch stays in the run folder.

### Verdicts

| Verdict | Means | Pull request |
|---|---|---|
| `better` | Changes kept and seen on screen. No heuristic scored lower, the total did not drop, the detector found no more than before | Ready for review |
| `mixed` | Changes kept, but something scored lower or looked the same at one viewport. The first line says what | Draft |
| `unverified` | Changes kept that were not fully checked: nothing rendered (no dev command, the server did not start, no way to take a picture), a viewport with no picture, or a detector that did not run | Draft, always |
| `no_change` | Nothing kept | None, and the empty worktree and branch are removed |

Scores from a model move by a point between runs. So no single move is judged on scores, only on the comparison and the checks, and a one-point drop at the end makes a run `mixed` without taking anything back.

**Blind has a limit.** The critic's prompt and pictures say nothing about which side is newer, and the role guard refuses its shell commands that read the run's state or the branch history. That is a fence, not a proof: the guard does not see every file read, so a critic that set out to find the answer could.

### Jev

Six questions, all logged and deciding nothing until [`calibrate`](#calibrate) switches one on. Jev reads text only: it never sees a picture. Switched on, it can cut a move, call a move a direction change, swap to the critic's second-choice command, and drop a move the critic preferred. The one thing it can add is a tick on a direction change the critic proposed, which is also what lets one run under `--auto`. It never keeps a move a rule dropped and never raises a verdict.

The right answers come from you: which moves you tick at the question, and `/real-skills:improve-design outcome <run-id>` once the pull request is merged.

### Configuration

`<repo>/.claude/improve-design.json`. `/real-skills:improve-design setup` writes it from what it detects. Full example: [`config.example.json`](skills/improve-design/config.example.json).

| Key | What |
|---|---|
| `dev` | `install`, `command` (with `{port}`), `cwd`, `ready_path`, `timeout_s`, and `copy`: ignored files the app needs to start. A file git tracks or does not ignore is refused; copies are removed when the run stops |
| `gates` | Commands that must stay green after every move |
| `ui_paths` | The files a move may change |
| `viewports`, `max_moves` | `1440x900` and `390x844`; 6 |
| `capture` | Your own picture command, for a screen that needs a signed-in session a script can have |
| `screenshots` | `false`. When on, before-and-after pictures are pushed to the `design-evidence` branch of the repository, where they stay |
| `pr` | `draft`: `auto` (default), `always`, `never`. `never` cannot make an unverified run ready. `labels` |
| `jev` | `shadow` (default), `live`, `off` |

Without a `dev` block the run still works, code-only: nothing is seen on screen and the pull request is a draft.

### Cost

A run of six moves is about six designers, up to six comparing critics, two scoring critics, and the picture-taking agents only when the script cannot take pictures itself. The question shows the count before anything is spent.

State lives in `~/.claude/state/improve-design/`: the run folder holds command output, detector findings, pictures and the patch of every dropped move; the log holds verdicts and counts.

---

## review-prs

Reviews one or more GitHub pull requests. Reviewers read each PR through a set of lenses, a script checks every finding before you see it, and a second reviewer tries to disprove the bugs.

**It never approves, requests changes or merges, and it never checks out or runs a PR's code.** Findings print in the chat. Only if you pick a PR are they posted, as one `COMMENT` review.

**Use it when** a PR is waiting on your review, or before you ask others to review yours. For a diff you have not pushed, use Claude Code's built-in `/code-review`; this skill is for PRs on GitHub and is the one that posts.

### Usage

```
/real-skills:review-prs [<pr-number-or-url>…] [--lens <name>…] [--no-refute]
/real-skills:review-prs post <run-id> [<pr>…]
/real-skills:review-prs outcome <run-id>
/real-skills:review-prs stats
```

With no arguments it lists the open, non-draft PRs where your review is requested and asks which to review. At most 10 PRs per run.

```
/real-skills:review-prs 412 415
/real-skills:review-prs https://github.com/acme/app/pull/412 --lens performance
```

### What it does

1. **Fetch, without checkout.** The script fetches the PR's commits and copies the head version of each changed file into a run folder. Your working tree is not touched and nothing from the PR is executed. Lockfiles, generated files, snapshots and binaries are left out.
2. **Pick lenses.** `correctness` and `standards` always run. `security`, `data`, `performance` and `accessibility` join when a changed path matches a rule, or when you pass `--lens`.
3. **Review.** One read-only reviewer per PR per lens, in parallel. Each replies with a JSON block: file, line, the exact text of that line, the problem and the fix.
4. **Refute.** One more reviewer per PR gets the bug-level findings and tries to prove each one wrong.
5. **Decide, in code.** The script applies the rules below and computes a verdict per PR.
6. **Report, then ask.** One block per PR. Then one question: post to which PRs? The default is none.

### The rules

| Rule | Effect |
|---|---|
| Citation | The quoted text is not within 3 lines of the cited line at the PR head: the finding is dropped |
| Already raised | A review comment already sits within 3 lines: dropped |
| Refutation | A bug is dropped only when the refuter says so **and** points at a line that itself passes the citation check. A refuter that is unsure, or cites nothing, leaves the bug standing with a note |
| Merge | Findings within 3 lines of each other in one file become one comment. Nothing is lost: the others are listed under it |
| Nit budget | At most 5 nits per PR are shown and posted. The rest are counted |
| Outside the diff | A real finding on a line GitHub cannot attach a comment to goes in the review body instead |

A bug, a risk and a security finding are never cut by a budget or by Jev. A security finding is never dropped on the refuter's word.

| Verdict | Meaning |
|---|---|
| `blocking` | A bug or a security finding survived |
| `comments` | Only risks, nits or questions survived |
| `clean` | Nothing survived. This is not an approval |
| `partial` | Shown beside one of the above when a lens did not report, files were not reviewed, a bug went unrefuted, or the PR moved during the review |

The citation check proves the quoted line exists at that commit. It does not prove the reviewer read it correctly, and the report says so.

### Example output

```
#412 Tighten session expiry · a1b2c3d · blocking · CI passing
src/auth/session.ts:L42: 🔴 bug: The expiry check uses <, so a token stays valid one tick too long. Use <=.
src/auth/session.ts:L88: 🔵 nit: The clamp is undocumented. Add a comment saying why ttl never goes negative.
Not shown: 1 finding failed the citation check, 2 nits over the budget.
```

The same findings, posted, are full sentences under a severity and lens label. The script writes both forms from the reviewer's fields, so no model rewrites a finding on its way out.

### Posting

- One `COMMENT` review per PR you pick: an inline comment per finding, and a body with the verdict, CI as read, anything outside the diff, and what was not shown.
- The script refuses to post when the PR has moved since it was reviewed (run it again), when the run already posted to that PR, when the PR is closed, and when nothing survived.
- The body ends with a line saying an automated reviewer produced it and the person posting checked it.

### Did the review help?

`/real-skills:review-prs outcome <run-id>` checks, for each posted finding, whether a later commit changed the line it pointed at. `stats` shows that rate per lens and severity. A lens nobody acts on is the one to tighten.

### Configuration

Optional, in `<repo>/.claude/review-prs.json`. Every key is optional and there is no setup step.

| Key | Default | Purpose |
|---|---|---|
| `standards` | `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` | Files the `standards` lens reads |
| `path_rules` | Built-in rules for auth, payments, migrations, queries and UI files | `[{pattern, lenses}]`. A regex match on a changed file adds lenses |
| `ignore` | Lockfiles, generated and vendored paths, snapshots, minified files, binaries | Extra globs to leave out |
| `max_nits` | `5` | Nits shown and posted per PR |
| `jev` | `shadow` | `shadow`, `live` or `off`. See [How these skills work](#how-these-skills-work) |

### Cost

Two to six reviewers per PR plus one refuter. A diff over 1,500 changed lines adds up to three more `correctness` reviewers, so the ceiling is 10 agents per PR and 100 for a full run of 10. The plan shows the count before anything starts. In Claude Code the reviewers run as one [dynamic workflow](https://code.claude.com/docs/en/workflows), which asks for approval; without workflows they run as background agents.

### Safety

- **A PR is someone else's text.** Its title, description, diff and code comments can contain instructions. Reviewers are told to treat all of it as data and to report an instruction as a finding.
- **Reviewers cannot write.** They are one plugin agent, `real-skills:reviewer`, with no edit tools. The role guard also denies it pushes, GitHub writes and any checkout.
- **One write.** `post`, with the event fixed to `COMMENT`, after you pick the PR.
- **State** lives in `~/.claude/state/review-prs/`: the run folder holds the diff, head files and prompts; the log holds counts and verdicts, never code or finding text.

---

## qa-this

QA for finished work: a ticket, a PR, a branch, or a feature you describe. It works out what "done" means for each one, checks it on an environment that is not production with the methods that fit, and leaves the evidence where the team looks.

**It never touches production, never fixes what it finds, never commits, and never creates a ticket or changes a status.** It writes test files (uncommitted), one report file, and one comment per ticket or PR.

### Usage

```
/real-skills:qa-this [<ticket|pr|branch|text>…] [--env <name>] [--method <m>…] [--screenshots] [--no-post]
/real-skills:qa-this setup
/real-skills:qa-this post <run-id> [<item>…]
/real-skills:qa-this outcome <run-id> <item> right|wrong
/real-skills:qa-this stats
```

```
/real-skills:qa-this ENG-412 ENG-415 --env staging
/real-skills:qa-this #88 --method database
/real-skills:qa-this the new CSV export on the orders page
```

With no arguments it asks what to QA, and offers the current branch and its PR, PRs merged in the last 7 days, and tickets waiting in your tracker's QA status. At most 10 items per run.

### What happens

1. **Start.** Each argument becomes an item. Config is read from `.claude/qa-this.json`, then `.claude/wtf.json`, then `.claude/changelog.json`, so a repo already set up for `wtf` is asked almost nothing.
2. **Criteria and checks.** The model reads the ticket, the diff and the code, and writes observable acceptance criteria and a list of checks, following [`qa-process.md`](skills/qa-this/references/qa-process.md).
3. **Plan.** The script picks the methods, drops checks it will not run, and names every criterion left without a check.
4. **One question.** The plan, the environment, whether using the product may change data there, sign-in, and what will be posted where.
5. **Run.** The script runs tests, queries and requests itself. The `qa-tester` agent walks the browser steps. The model writes new test files.
6. **Status, evidence, report.**

### Methods

| Method | What it does | Chosen when |
|---|---|---|
| `checks` | The repo's own test and end-to-end commands, on the tests that matter | A test command is configured |
| `browser` | Numbered steps in the built-in browser, one screenshot per step | A UI file changed, or a criterion is something a user sees |
| `database` | One `SELECT` per check: did the write land, is the row the right shape | A schema, migration or data-layer file changed, or a path rule says so |
| `api` | The HTTP requests the plan lists, against the environment | A route or handler changed and no UI change covers it |
| `new_tests` | Test files for criteria no existing test covers | A criterion has no test, and `tests.globs` says where tests live |
| `runtime` | New errors in Sentry, logs or analytics during the run | Runtime sources are configured and the app was exercised |

`--method` adds one, and so can you at the plan question. A method this session cannot run is listed with the reason, and whatever depended on it is reported as not tested.

### What the script holds

| Rule | How |
|---|---|
| Never production | An environment must be `local`, `preview` or `staging`, and its host must not be, or sit under, a `production_hosts` entry. With none listed, nothing that touches an environment runs |
| Reads only | A database check is refused unless it is exactly one plain `SELECT`. Whatever Postgres, MySQL and SQLite read differently is refused outright: comments, backslashes, backticks, dollar quotes. A function must be on a short read-only list. A row limit is added |
| No credentials | A request with a credential-looking header is refused. The user signs in to the browser themselves |
| Writes need a yes | A request other than `GET` or `HEAD` runs on `local`, or elsewhere only after you accept data changes at the plan question |
| Results are recorded, not reported | Exit codes, row counts and response statuses come from the script. Browser results are recorded once. A screenshot counts only if it is an image file inside that item's own folder |
| Only test files | Every tracked and visible file is hashed before new tests are written and again before they run. Any other changed file, or a moved `HEAD`, fails the new tests. Nothing is reverted; you are told |
| A status is computed | `passed` needs every criterion covered and every check passed. A criterion without a check makes the item `partial` |

The database command in the config is your own string, and the script cannot see where it points. Point it at a non-production database, with a user that can only read: that user is the real boundary, and the statement filter is a second one.

### Evidence

A ticket gets a comment, a PR gets a PR comment, and a branch or a description appears only in the report. The comment is built by the script from recorded results, at most 12 lines:

```markdown
**QA: failed** · staging · `9e8d7c6` · 7 of 8 checks passed

- ❌ An empty date range shows an error: the page shows a blank table (browser)
- ⚪ Not tested: The export is emailed (no check ran for it)
- ✅ Export downloads a CSV with one row per order (browser, 3 steps)
- ✅ The row count matches the orders table (database: 42 rows)

New tests, uncommitted: `e2e/orders-export.spec.ts`
Report: `docs/qa/2026-10-08-orders-export-1f3a.md` · run `qa-20261008-1412-1f3a`
```

- `"post": "ask"` (default) shows the comments before sending; `"auto"` sends them; `"off"` or `--no-post` sends nothing.
- **Screenshots are opt-in** (`"screenshots": true` or `--screenshots`): a screenshot of staging can show customer data, and on GitHub it is pushed to a `qa-evidence` branch of the repository.
- Comments carry row counts and column names, never row values, and pass through the redaction library. One that cannot be redacted is not sent.
- A failed item gets its comment and a bug draft in the report. Filing it is yours: `/real-skills:wtf <ref>` to triage, `/real-skills:do-shit <ref>` to fix.

The report is one file under `docs/qa/`, at most 60 lines: a status table, the failed checks with a bug draft, what was not tested and why, new test files, and the command to rerun.

### Configuration

`<repo>/.claude/qa-this.json`. The first run asks only for what no config file answers; `/real-skills:qa-this setup` changes it later. Full example: [`config.example.json`](skills/qa-this/config.example.json).

| Key | What |
|---|---|
| `environments`, `production_hosts`, `tracker` | Read from `.claude/wtf.json` when it has them |
| `tests` | `unit` and `e2e` commands, `globs` for where a new test may go, `timeout_s` |
| `databases` | Per environment, a command that reads SQL on stdin and prints rows |
| `path_rules` | `{pattern, methods}`: paths that always get a method |
| `post`, `screenshots`, `report_dir` | `ask`, `false`, `docs/qa` by default |
| `jev` | `shadow` (default), `live`, `off` |

State lives in `~/.claude/state/qa-this/`: the run folder holds command output, query results and screenshots; the log holds statuses and counts.

---

## check-infra-and-migrations

The last look before a push. Give it a pull request, a promotion or two commits, and it says whether the database migrations and infrastructure changes in between are safe to push to the environment they are headed for, and what has to happen before, during and after the deploy.

**It never applies a migration, never deploys, merges, pushes or approves, and never checks out the change.** It writes one comment on the pull request, after you say yes.

### Usage

```
/real-skills:check-infra-and-migrations [<pr>… | promotion | <base>..<head>] [--target <env>] [--no-live] [--no-post]
/real-skills:check-infra-and-migrations setup
/real-skills:check-infra-and-migrations post <run-id> [<target>…]
/real-skills:check-infra-and-migrations outcome <run-id> <target> right|wrong [<verdict>]
/real-skills:check-infra-and-migrations stats
```

```
/real-skills:check-infra-and-migrations promotion
/real-skills:check-infra-and-migrations #2894
/real-skills:check-infra-and-migrations origin/production..origin/main --target production
```

`promotion` is the open PR into your production branch, or, with none open, everything on main that production does not have yet. With no arguments it takes the current branch's open PR, else the open promotion. At most 5 targets per run.

### What happens

1. **Start.** Each target becomes a commit range, read from git with nothing checked out. Changed files are sorted into four buckets: `migration`, `infra`, `pipeline` (deploy workflows, Dockerfiles) and `env` (env example files). A change with nothing in any bucket ends here: "no migration or infrastructure change".
2. **Rules.** The script reads every SQL statement on its own, with comments, string literals and function bodies taken out first, and names what it does. It checks the migration history (an edited migration that already exists on the base branch, one that sorts before the newest, a Drizzle journal that does not match the files), searches the code at the head for every dropped or renamed column, and reads added and removed lines of infrastructure files for a removed database or bucket, a weakened deletion guard, open ingress or a wildcard IAM action. Every rule is in [`rules.md`](skills/check-infra-and-migrations/references/rules.md).
3. **Live reads, if you configured any.** Three read-only commands of your own per environment: `applied` (which migrations it has run), `sizes` (rows per table) and `plan` (`cdk diff`, `terraform plan`). The skill shows each command, says plainly when it reads production, and waits for a yes. From them it knows what is really pending, turns a lock on a big table into a blocker, and counts what a plan destroys or replaces.
4. **Reading.** The model reads the changed files for what a rule cannot see, following [`what-to-check.md`](skills/check-infra-and-migrations/references/what-to-check.md): two releases done as one, code that needs a column before it exists, a backfill inside a schema migration. Every finding needs a `file:line` and a quote, and the script drops the ones that do not hold. The model can add a finding. It cannot remove or soften a rule hit.
5. **Verdict and runbook.** One verdict per target, and the steps: what to do before, the order of migrations, code and infrastructure, what to check after, and what can be rolled back.

| Verdict | Means |
|---|---|
| `blocked` | At least one blocker: data loss, or a migration history that cannot apply cleanly |
| `caution` | No blocker, at least one risk: it can break running code, lock a table or take something down |
| `unverified` | Nothing found, and something could not be checked. The verdict says what |
| `safe` | Nothing found, and nothing unchecked |
| `nothing_to_check` | No migration or infrastructure file changed |

`safe` is deliberately hard to get: every statement classified, and every infrastructure change read from a plan. A diff shows a removed line, not what the provider will do with it, so an infrastructure change without a plan is `unverified` at best.

**The verdict is advice. You decide whether to push.**

### What it catches

| In | Blockers | Risks |
|---|---|---|
| SQL migrations | `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DELETE` with no `WHERE` | A type change, `SET NOT NULL`, a `NOT NULL` column with no default, a rename, an index without `CONCURRENTLY`, a foreign key without `NOT VALID`, a scanning constraint, an `UPDATE` with no `WHERE`, row-level security turned on or off, a dropped policy or function, a grant to `PUBLIC` |
| Migration history | An edited or deleted migration that is already on the base branch, a Drizzle journal that does not match | A migration that sorts before the newest, a dropped name the code still uses, a target that has run something this tree lacks |
| Infrastructure | A removed database, bucket, table, queue or volume; a plan that destroys or replaces one | `RemovalPolicy.DESTROY`, `deletion_protection = false`, `0.0.0.0/0` ingress, an IAM `*` action, a changed instance class or engine version, a removed variable |

It knows the difference between a lock on a table that exists and one on a table the same change creates, between `DROP POLICY` and a drop followed by a create, and between a `WHERE` that limits a statement and one that does not (`WHERE true`, a `WHERE` inside a subquery). It does not trust what it cannot read: `CREATE TABLE IF NOT EXISTS` may create nothing, so a drop after it is still a drop; a `DO` block, a `CALL`, a psql `\` line and anything after a MySQL `DELIMITER` are listed as not checked. Rails, Alembic, Knex and Django migrations get their destructive calls recognised; the rest of such a file is listed as not checked.

### Configuration

`<repo>/.claude/check-infra-and-migrations.json`. The first run asks once; without the file the skill uses what it detects (Drizzle, Supabase, Prisma, Rails, Alembic, Django, Knex and Flyway folders; CDK, Terraform, SST, Serverless, Pulumi, CloudFormation, `render.yaml`, `vercel.json`, `fly.toml`). Full example: [`config.example.json`](skills/check-infra-and-migrations/config.example.json).

| Key | What |
|---|---|
| `release`, `environments`, `production_hosts` | Read from `.claude/changelog.json`, `.claude/wtf.json` or `.claude/qa-this.json` when they have them |
| `migrations` | `{tool, dir, applied, applied_by}`. `applied` is `before_deploy`, `after_deploy` or `manual`, and decides which side of the deploy a change can break. `[]` for none |
| `infra` | `{tool, paths, applied_by}`. `[]` for none |
| `pipeline`, `env_files` | Globs for deploy workflows and env example files |
| `targets` | `{branch, env}`: which branch deploys to which environment |
| `live` | Per environment name: `applied`, `sizes`, `plan` commands. Optional, and nothing is guessed |
| `big_table_rows` | `1000000` by default |
| `post`, `jev` | `ask` and `shadow` by default |

**About the live commands.** They are your own shell strings, and the script cannot see what they do. Use credentials that can only read: that is the real boundary. A command containing a write word (`deploy`, `apply`, `push`, `migrate`, `up`, `destroy`, `drop`, `delete` and a few more, also as `db:migrate` or `delete-db-instance`) is refused when the config loads, which catches a paste mistake and nothing more. `plan` runs the repository's own code, so it runs only when the working tree is clean and already at the head of the change, and the skill never checks anything out to make that true.

State lives in `~/.claude/state/check-infra-and-migrations/`: the run folder holds the diff, the head version of each file read and the raw output of live commands (treat it as sensitive); the log holds verdicts and counts.

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

## calibrate

The other skills ask Jev small yes/no questions and get a number back. For 43 of those questions the number is logged and ignored, because nobody has checked whether it can be trusted. `calibrate` is that check. It is how "take the human out of the loop" gets earned, one question at a time.

```
/real-skills:calibrate                       progress per question
/real-skills:calibrate label [<skill>[/<question>]]   answer Yes / No on past cases
/real-skills:calibrate apply                 switch on what is ready, one approval per question
/real-skills:calibrate revoke <skill>/<question>
```

User-invoked only. It makes no network call and edits no skill. It changes one file, `~/.claude/state/calibration/calibration.json`, and only after you approve a named question.

### How a question gets switched on

1. **Cases.** Every time a skill asks Jev something, it logs the answer with the question's threshold, which side of it makes the skill act, and which mistake would be the unsafe one.
2. **Right answers.** Some arrive by themselves: your answer at a `do-shit` checkpoint or re-approval, `/real-skills:wtf outcome`, and whether you took the recommended answer in `quick-ask-me`. For the rest, `label` shows up to 12 past cases at a time and you answer Yes, No or Can't tell. The score is hidden while you label, so it cannot steer you.
3. **The bar.** At least 30 labeled cases with 5 of each answer, and a threshold with **zero unsafe errors** among them. Of the thresholds that pass, it takes the middle one, away from the unsafe side. A question that would then act on fewer than one case in ten is left off.
4. **Your approval**, per question. The script recomputes the bar itself and refuses anything that does not meet it.

A switched-on question decides only in `live` mode. In `shadow`, the default for most skills, it still only logs.

### What keeps it honest afterwards

- **Spot checks.** One decision in ten is still put to you, chosen by a hash of the case so it is repeatable. Once a skill stops asking, this is where new right answers come from.
- **Auto-revoke.** One right answer on the unsafe side switches the question off at once. Switching it back on needs the bar met again with that case counted. A few questions have no unsafe side: when they act they only add an ask or a check (`wtf`'s three, and the vague-scope and vague-seam checks). Those are not switched off automatically; the status line shows how accurate each is now, and `revoke` is by hand.
- **Off switch.** `REAL_SKILLS_CALIBRATION=off` makes every skill ignore the file.

### What to expect

Thirty clean cases is weak evidence. Only the cases on the side that could have gone wrong count, so with 30 labeled the real unsafe rate could still be one in ten or worse. The report says so with the number (`bound`, from `exposed` cases), and the spot checks are the real safety net. Most questions will read `not enough data` for weeks of normal use; that is the honest state.

It can never switch on `do-shit`'s merge approval or QA approval, a code veto, or `wtf`'s verdict rules. Those are not Jev questions and have nothing to switch.

The logs it reads hold a short, redacted line per case (a PR title, a candidate question, a spec line) so you can recognise it when labeling. `wtf` logs no text at all.

---

## handoff-with-prompt

For the moment you stop mid-task and someone else picks it up: a new session, another tool, or you tomorrow. It writes the state of the work to a file, then prints a prompt that points the next agent at that file.

**User-invoked only.** It writes one file. No commit, no push, no tracker comment.

```
/real-skills:handoff-with-prompt [why you are stopping]
```

```
/real-skills:handoff-with-prompt context is full, tests still red
```

### What happens

1. **Locate.** Repo and branch give the path: `~/.claude/handoffs/<repo>--<branch>.md`. One file per branch; a newer handoff replaces the older one.
2. **Gather.** Uncommitted files, unpushed commits, the open PR, and what the session was trying to do.
3. **Write the file.** Under 60 lines: Goal, State, Done, Next, Landmines, Verify. Written for a reader with no context.
4. **Print the prompt.** One code block, nothing after it, so it copies cleanly.

With nothing in flight (clean tree, nothing unpushed, no stated goal) it writes no file and prints no prompt.

### The prompt

At most 25 lines, in full sentences, with absolute paths. It tells the next agent to read the handoff file, then check it against `git status` and trust git where they differ. It also repeats the goal, the first next action, the landmines and the command that proves the work is done, so the agent can start even if it cannot read the file.

| It always says | Why |
|---|---|
| Working directory and handoff path, absolute | The next agent may start somewhere else |
| That a worktree is a worktree, and where the main checkout is | Same filenames live on another branch there |
| That uncommitted changes are work in progress | A fresh agent may otherwise discard them |
| Do not push, merge or open a PR until told | A new session starts with no approval. Delete the line if you want to give it |

No secret goes into the file or the prompt: an env var is named, never printed.

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
  wtf/                  skill + wtf.mjs (probe, cite, skew, verdict rules) + tracker, hosting and runtime adapters
  improve-design/       skill + improve.mjs (moves, worktree and dev server, checks, blind comparison, verdict, pull request)
  review-prs/           skill + review.mjs (citation check, drop rules, verdict, post) + lens checklists + review workflow
  qa-this/              skill + qa.mjs (methods, run, status, comment, report) + env and SQL rules + tracker adapters
  check-infra-and-migrations/  skill + check.mjs (buckets, statement and infra rules, live reads, verdict, runbook, comment) + rules reference
  calibrate/            skill + calibrate.mjs (status, label, apply, revoke) + lib/bar.mjs (the bar)
  handoff-with-prompt/  skill only: no script, no Jev
                        every skill that asks Jev carries scripts/lib/calibration.mjs (kept identical by a test)
                        do-shit, changelog, quick-ask-me, wtf, review-prs, qa-this, check-infra-and-migrations,
                        improve-design:
                        references/report-style.md; all but do-shit carry their own scripts/lib/jev.mjs + redact.jq
                        (kept identical by a test)
agents/                 17 do-shit role agents, the review-prs reviewer and the improve-design critic,
                        spawned as real-skills:<role>
hooks/                  hooks.json + guard-roles.mjs (guards the role agents, the reviewer and the critic) + lib/redact.jq
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

**Copied files.** `changelog`, `quick-ask-me`, `wtf`, `review-prs`, `qa-this`, `check-infra-and-migrations` and `improve-design` must work when installed as a single folder, so they carry copies of `jev.mjs`, `redact.jq` and `report-style.md`. Edit the source (`skills/do-shit/scripts/lib/jev.mjs`, `hooks/lib/redact.jq`, `skills/do-shit/references/report-style.md`), copy it over the others, and `sync.test.mjs` confirms they match. The same goes for `skills/calibrate/scripts/lib/calibration.mjs`, copied into the nine skills that ask Jev.

**Calibrating a Jev question.** Each script lists its unproven questions (for `ask-and-create-specs`, thresholds) in an `UNCALIBRATED` set and logs every answer as a case record with its threshold, direction and unsafe side. [`/real-skills:calibrate`](#calibrate) reads those records and switches a question on per machine. Removing an id from the set switches it on for everyone who installs the plugin: do that only with evidence from more than one machine. A new question needs a case record (see `kase(...)` in any script) and a line in `skills/calibrate/scripts/lib/catalog.mjs`; `sync.test.mjs` fails until both exist.

**Releasing.** Bump `version` in `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` in any PR that changes what the plugin ships. `claude plugin update` compares that string, not the commit: with the version unchanged it reports "already at the latest version" and installed copies keep the old files.

**Adding a skill:** create `skills/<name>/SKILL.md` (frontmatter `name`, `description`, optional `argument-hint`) and `skills/<name>/agents/openai.yaml` for Codex, then add it to the tables at the top of this file and to the `description` in `.claude-plugin/plugin.json`.

## License

MIT. `skills/quick-ask-me` and `skills/ask-and-create-specs` build on [mattpocock/skills](https://github.com/mattpocock/skills) (MIT): their interview style follows `grill-with-docs`, the glossary format follows `domain-modeling`, and `references/CONTEXT-FORMAT.md` and `references/ADR-FORMAT.md` are adapted from `domain-modeling`.

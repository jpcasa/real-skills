# improve-design: a design pass that proves each change

Date: 2026-10-09 · Branch: `jpcasa/improve-design-skill-jev-05ade7` · Ships as `/real-skills:improve-design`, plugin `0.11.0`

## Goal

Add `/real-skills:improve-design`: critique one screen with impeccable's rubric, turn the issues into small design moves, apply them one at a time, keep only the moves that a blind comparison and the code checks say made the screen better, then push the branch and open a pull request that shows the evidence.

impeccable supplies the taste and the method. The model critiques, edits and compares. A script decides which moves run, whether each one stays, the overall verdict and the pull-request text.

## Decisions taken (asked 2026-10-09)

- **Jev:** shadow first. Code rules and the blind comparison decide. Jev scores every decision and is logged; `/real-skills:calibrate` switches a question on per machine.
- **Ambition:** any impeccable command is allowed, including the ones that change the visual direction (`bolder`, `quieter`, `colorize`, `animate`, `delight`, `overdrive`). No refine-only cap.
- **Checkpoint:** one stop, after the critique, showing scores and ranked moves. `--auto` skips it.
- **PR shape:** one pull request per run, one commit per kept move.

How the first two fit together: until a question is calibrated, the critic proposes the command for each move and you pick at the checkpoint. Under `--auto` a move that changes the visual direction is skipped and listed, because nothing calibrated has approved it yet.

## Non-goals

- New screens or features. This improves a screen that exists. New work is `/impeccable shape`.
- Changing logic, data fetching, validation or state shape.
- Production, in any form. The screen is rendered from the run's own worktree on localhost.
- Merging, approving, or pushing to a branch it did not create.
- Typing credentials. A screen behind sign-in needs you to sign in to the browser pane.
- Native apps. Web only in this version.
- Repairing impeccable's own files (`PRODUCT.md`, `DESIGN.md`, `.impeccable/`). It reads them and writes none.

## Approach

### 1. Commands

```
/real-skills:improve-design <route|file> [--route <path>] [--base <branch>|--pr <n>] [--direction <command>] [--max-moves <n>] [--auto] [--no-pr] [--screenshots]
/real-skills:improve-design setup
/real-skills:improve-design outcome <run-id> [<move> right|wrong]
/real-skills:improve-design stats
```

One target per run: a route (`/settings`) or a source file plus `--route`. With no argument it asks. `--pr <n>` stacks the work on that pull request's head branch. `--direction` forces one command onto the plan.

### 2. Flow

1. `start`: load config, refuse a production host, fetch the base, create worktree `.claude/worktrees/id-<run-id>` on branch `improve-design/<slug>-<date>`, install, start the dev server on a free port, wait for the ready path.
2. `baseline`: the script runs impeccable's detector. A `qa-tester` captures the screen at each viewport. A `design-critic` scores it with the critique and audit rubrics and returns issues.
3. `plan`: the script turns issues into moves, ranks them, cuts to `max_moves`, and marks direction changes. Jev scores each move.
4. Checkpoint: scores, the ranked moves, what was cut and why, and one question: which moves, and whether to attach screenshots to the pull request.
5. Per move, in order: `designer` edits and commits; the script checks it; a `qa-tester` captures again; a fresh `design-critic` compares unlabeled before and after; the script keeps the commit or drops it. The next move starts from what was kept.
6. `final`: a fresh `design-critic` re-scores the result without seeing the baseline scores. The script computes the verdict.
7. `ship`: push, open the pull request, stop the dev server, print the verdict. `--no-pr` stops before the push.

### 3. Config: reuse first

`.claude/improve-design.json`. `production_hosts` and `environments` fall back to `.claude/qa-this.json`, then `.claude/wtf.json`, then `.claude/changelog.json`. Gates fall back to `.claude/do-shit.json`. `setup` probes the package manager, the dev script and the framework, and asks once.

```json
{
  "base": "main",
  "dev": { "install": "pnpm install --frozen-lockfile", "command": "pnpm dev --port {port}", "ready_path": "/", "copy": [".env.local"], "timeout_s": 180 },
  "gates": ["pnpm typecheck", "pnpm lint"],
  "ui_paths": ["**/*.tsx", "**/*.css", "**/tailwind.config.*", "public/**"],
  "viewports": ["1440x900", "390x844"],
  "max_moves": 6,
  "screenshots": false,
  "pr": { "draft": "auto", "labels": [] },
  "jev": "shadow"
}
```

`dev.copy` names git-ignored files the script copies from the main checkout into the worktree so the app can start. The script refuses a path that git does not ignore, never prints the contents, and deletes the copies when the run ends. Without a `dev` block the run is code-only (see Verdict).

### 4. Moves

A move is one issue, one impeccable command, one intent line, and the files it may touch. The critic proposes; the script checks the command against impeccable's list and sorts it:

| Kind | Commands | At the checkpoint | Under `--auto` |
|---|---|---|---|
| `refine` | `polish`, `layout`, `typeset`, `clarify`, `distill`, `harden`, `adapt`, `optimize`, `onboard` | Preselected | Runs |
| `shift` | `bolder`, `quieter`, `colorize`, `animate`, `delight`, `overdrive` | Listed, not preselected | Skipped and listed |

Ranking, in code: severity (P0 first), then detector-backed issues, then audit issues, then the rest. Two issues that name the same element and command merge into one move. `refine` moves run before `shift` moves, so a rejected direction change costs nothing that came before it.

### 5. The harness: `scripts/improve.mjs`

| Command | What it does |
|---|---|
| `probe` | Package manager, dev script, framework, impeccable's install path. No impeccable, no run |
| `start` | Config, production refusal, worktree, branch, install, dev server (pid recorded) |
| `detect` | Runs impeccable's `detect.mjs --json` on the target; stores findings keyed by rule and file |
| `baseline-record` | Parses the critic's JSON: ten heuristic scores, five audit scores, issues with severity, element, command |
| `plan` | Builds, merges, ranks and cuts the moves; asks Jev; writes the checkpoint text |
| `approve` | Records the checkpoint answers; writes labels |
| `move-check` | After the designer's commit: paths inside `ui_paths`, gates, detector delta against the state before this move |
| `shots-record` | Keeps a screenshot only when the file exists in the run folder; hashes it |
| `compare-plan` | Assigns each before/after pair to `X` or `Y` at random and keeps the key |
| `compare-record` | Un-blinds the critic's answers; decides keep or drop; drops the commit |
| `final` | Records the re-score; computes the verdict |
| `ship-plan`, `ship` | Builds the pull-request body from recorded results only; pushes; opens the pull request |
| `stop` | Stops the dev server, removes copied files; the worktree stays until the pull request closes |
| `outcome`, `stats` | Labels and accuracy |

### 6. Keeping or dropping a move

A move is dropped when any of these holds. The first four are vetoes nothing can override:

- its commit touches a file outside `ui_paths`;
- a gate that was green before it is red after it;
- the detector reports a finding that was not there before it (advisory findings do not count);
- the designer reported `blocked` or committed nothing;
- the blind critic preferred the before picture at any viewport, or named something the move broke and pointed at where;
- a calibrated Jev question says so (section 8).

A move with no visible effect (accessibility names, focus order) is judged on the detector and audit delta instead of pictures, and is kept only when the issue it names is gone.

Dropping means the commit leaves the branch. The script saves the patch to the run folder first, then resets the worktree to the move's parent, and only when all four are true: `HEAD` is that move's commit, the tree is clean, the branch has never been pushed, and the worktree is the run's own. Otherwise it stops and says so.

### 7. Verdict

| Verdict | When | Pull request |
|---|---|---|
| `better` | At least one move kept; final total at or above baseline; no heuristic lower; detector count not higher; every kept visual move has pictures | Ready for review |
| `mixed` | Moves kept, but one heuristic dropped by one, or the critic saw no difference at one viewport for a kept visual move | Draft, with the reason on the first line |
| `unverified` | Moves kept without rendered evidence: no `dev` block, server never came up, sign-in blocked the capture | Draft |
| `no_change` | Nothing kept | None. The run prints why each move was dropped |

`pr.draft`: `auto` (the table), `always`, `never`. `never` cannot make `unverified` ready.

Heuristic scores from a model move by a point between runs. That is why the per-move decision rests on the pairwise blind comparison and the code checks, and why a one-point drop on one heuristic gives `mixed` and reverts nothing.

### 8. Jev

Jev reads text only (the contract in `lib/jev.mjs`: a JSON state and questions). It never sees a screenshot, the diff or source. Five questions, all uncalibrated at release, catalog 37 to 42:

| Question | Asked per | Once calibrated | Unsafe error |
|---|---|---|---|
| `move_worth_doing` | move, at plan | Below threshold: cut from the plan | Cutting a move that mattered |
| `changes_visual_identity` | move, at plan | At or above: treated as `shift` whatever its command | Missing a direction change |
| `alternative_fits_better` | move, at plan | At or above: swap to the critic's second-choice command | none |
| `is_improvement` | move, after compare | Below: drop the move | Calling a regression an improvement |
| `harms_another_state` | move, after compare | At or above: drop the move | Missing damage |

Calibrated, Jev can cut, reclassify, swap a command or drop a move. It can never keep a move a rule dropped, never clear a veto, and never raise a verdict. `changes_visual_identity` is the question that, once on, lets `--auto` run a direction change the critic proposed and Jev scored as needed; until then `--auto` skips them.

Sent: the issue line, the intent line, command names, file paths, detector rule names and counts, heuristic names and scores, the critic's one-line observations. Each at most 300 characters, scrubbed with the shared redaction library. `"jev": "off"` or `IMPROVE_DESIGN_JEV=off` sends nothing.

Labels come from the checkpoint (a move you unticked, a `shift` you approved, a command you changed), from `outcome <run-id>` (a merged pull request labels its kept moves as improvements unless you say otherwise per move), and from `/real-skills:calibrate label`.

### 9. Agents

- **`real-skills:design-critic`** (new, read-only: Read, Grep, Glob, Bash, Skill, browser read tools). Three jobs, each a fresh spawn: baseline critique, pairwise comparison, final re-score. It loads impeccable and uses the `critique` and `audit` rubrics, returns JSON only, and skips the parts of those commands meant for a person: no questions, no snapshot written to `.impeccable/`.
- **`real-skills:designer`** (exists). One spawn per move, told the impeccable command to run. It already loads impeccable before touching UI.
- **`real-skills:qa-tester`** (exists). Captures the screen; signs in nowhere.

The comparison critic is told the issue and shown `X` and `Y`. It is not told which is newer, what changed, or what any score was.

### 10. The pull request

Built by `ship-plan` from recorded results, at most 40 lines before screenshot lines: verdict, the score table before and after, one line per kept move (issue, command, commit), one line per dropped move with the reason, what was skipped under `--auto`, and how to re-check. Written in full sentences for teammates.

Screenshots are opt-in (`"screenshots": true`, `--screenshots`, or a yes at the checkpoint): before and after per viewport, pushed to the orphan `design-evidence` branch and linked. Off by default because a screenshot lands in the repository for good.

### Changed while building

- **The script takes the pictures.** The spec had a `qa-tester` agent capture every picture. Now `shoot` does it itself: the user's `capture` command, else the repo's Playwright, else a Chrome on the machine. An agent captures only when none of those exists or the route redirects (a sign-in only the browser pane has), and `shots-record` checks what it hands back. A picture is then a file the script made, and a six-move run needs no picture-taking agents.
- **Chrome is driven over the DevTools pipe.** Found in a live run: `--window-size=390` does not reflow a page (Chrome's window cannot be that narrow), it crops it. `lib/chrome-shot.mjs` sets the viewport through the protocol instead, with no port and no dependency.
- **Identical pictures need no critic.** Byte-identical before and after at every viewport means nothing changed on screen: the move is dropped as `no_visible_difference` without a comparison.
- **Six Jev questions, not five** (catalog 37 to 43). `direction_change_warranted` was added. The spec let `changes_visual_identity` both reclassify a move and let a direction change run under `--auto`; those are opposite errors, and `/calibrate` checks one unsafe side per question. Now `changes_visual_identity` only reclassifies (unsafe: missing one) and `direction_change_warranted` is the one answer that adds something: a tick on a direction change the critic proposed (unsafe: saying yes wrongly). A checkpoint answer that contradicts it switches it off again.
- **More commands.** `start` was split into `start` (fast, creates the worktree), `prepare` (install, gates) and `serve` (dev server), so no single call runs for many minutes. `move-start` records where a move begins, since a designer may make several commits. `brief` writes the scoring critics' prompts. `shoot` and `shots-record` replace the capture step.
- **Two more vetoes.** `uncommitted_changes` (the designer left work outside a commit; it is saved as a patch and cleared) joins `no_commit` and `blocked`.
- **`mixed` is wider.** Any failed condition of `better` with rendered evidence gives `mixed`: a heuristic lower, the total lower as a share of what applied, more detector findings, or no difference at one viewport.
- **A move with nothing to see** is kept when the detector saw its finding go, or when a critic's `path:line` is a real line. The spec said "the detector and audit delta"; there is no audit re-run per move.
- **Gates have no fallback file.** `.claude/do-shit.json` has no plain list of gate commands to reuse. `setup` proposes them from `package.json`. `production_hosts` is the only key read from the other skills' configs, and only to explain why a URL target was refused: the screen is always rendered on localhost.
- **A run that kept nothing removes its worktree and branch** at `stop`, when the branch holds no commit of its own and was never pushed.
- **The comparison folder is outside the run folder**, under neutral file names with the same timestamp, so nothing the critic is handed points at the run or says which side is newer.
- **The role guard** lets only `designer` edit inside an `id-*` worktree, and holds it there to the repo's `ui_paths` when `.claude/improve-design.json` sets them.
- **After an independent review of the harness** (2026-10-09, 7 defects and 13 risks reported, all checked against the code):
  - A route is now a plain path. Before, a target such as `/a;touch x` reached `sh -c` through the user's `capture` command. The base branch is checked as a name before it reaches `git fetch`.
  - A detector that did not run no longer passes for "no new finding": the move is kept as not fully checked and the run is `unverified`.
  - Changed files are listed without rename detection, so moving a logic file into a ui path is still out of scope.
  - `move-start` cannot be repeated over a move's own commits, `move-check` stops when the branch history was rewritten, and `ship` checks that every kept commit is still on the branch.
  - Every move that passed its checks is pictured, also one with nothing to see, and every configured viewport must be answered for. Before, a failed picture or an unpictured move could leave `better` standing on pictures that did not show the change.
  - The baseline cannot be recorded or pictured again once a move has started.
  - A decision is written to disk before any commit is taken off the branch.
  - `ship` can be run again when the pull request could not be opened after the push.
  - Env files are not copied or removed through a symlinked folder, and the dev server is stopped only when the pid still has the start time the run recorded.
  - The role guard resolves a path before judging it (`<worktree>/../..` used to pass, for `ds-*` worktrees too), a config that cannot be read allows nothing, and the critic's shell cannot read the run's state file or the branch history.
  - Left as is: a critic can still find out which picture is newer through plain file reads the guard does not see; a build role's shell is not held to its worktree (true of every `/do-shit` role before this change); a degraded detector run (pattern matching only) is noted in the verdict and the pull request, not treated as unverified, because that is how impeccable 4.1.3 runs when its parser modules are not installed.

### 11. Rejected alternative

**Let the model run `/impeccable critique`, then `/impeccable polish`, then open a pull request.** That is what a person does by hand today, and it has no moment where anything can say no: the same context that made the change judges it, every change lands as one diff, and a regression at the mobile width ships with the improvements. Splitting the work into moves, each compared blind and each a commit, is the whole reason for the skill.

## Interfaces and data

- New: `skills/improve-design/` (`SKILL.md`, `config.example.json`, `agents/openai.yaml`, `references/` with `report-style.md`, `setup.md`, `moves.md`, `compare.md`, `scripts/improve.mjs`, `scripts/lib/`, `scripts/test/`), `agents/design-critic.md`.
- Changed: `hooks/guard-roles.mjs` (build roles may also edit inside `.claude/worktrees/id-*`; `design-critic` joins the read-only set), `skills/do-shit/scripts/test/sync.test.mjs` (ninth skill in the redaction, calibration and question-list checks), `skills/calibrate` (five more questions in its list), `README.md`, `.claude-plugin/plugin.json` (`0.11.0`).
- State: `~/.claude/state/improve-design/<run-id>/` (`run.json`, prompts, detector output, gate output, screenshots, dropped patches), plus `jev.jsonl` and `log.jsonl`. Not pruned. Screenshots can show whatever the local app shows.
- Writes outside state: one worktree, one branch, one commit per kept move, one push, one pull request, and (opt-in) one push to `design-evidence`.
- Requires the impeccable plugin and `gh`. Without the browser pane the run is code-only and `unverified`.

## Risks

- **A regression that ships as an improvement.** The unsafe error. Mitigations: the critic who compares did not make the change and does not know which picture is newer; the script holds the key; gates and the detector are run by the script; Jev can only subtract.
- **Noisy scores.** Covered in section 7: pairwise comparison decides, absolute scores only shade the verdict.
- **The dev server serves the wrong tree.** The script starts its own from the worktree on its own port and records the pid; it never uses a server that was already running.
- **Copied env files.** Limited to git-ignored paths named in config, never printed, removed at `stop`.
- **Dropping a commit.** Guarded by the four conditions in section 6, with the patch saved first.
- **Cost.** A run of six moves is roughly 6 designers, 8 critics and 8 captures. `max_moves` is the dial; the checkpoint shows the count before anything is spent.
- **impeccable changes.** The skill calls `detect.mjs` and reads the rubric by path. `probe` records impeccable's version; a missing script fails at `start`, not mid-run.

## Build order

1. `lib/` copies (`jev`, `calibration`, `scrub`, `glob`, `paths`, `redact.jq`), `config.mjs`, `probe`.
2. `start` and `stop`: worktree, branch, dev server.
3. `detect`, `baseline-record`, `plan`, `approve`, with `questions.mjs`.
4. `move-check`, `shots-record`, `compare-plan`, `compare-record`, drop.
5. `final`, verdict, `ship-plan`, `ship`.
6. `outcome`, `stats`; `design-critic` agent; guard change.
7. `SKILL.md`, references, README, version, sync tests.

## Verification

```bash
node --test skills/*/scripts/test/*.test.mjs
claude plugin validate . --strict
```

Tests that must exist:

- Config precedence across the fallback files; a production host refused; `dev.copy` refuses a tracked path.
- `plan`: ranking order; merge of two issues on one element; cut at `max_moves`; a `shift` command is not preselected and is skipped under `--auto`; an unknown command is refused.
- `move-check`: a file outside `ui_paths` is a veto; a gate that turns red is a veto and one that was already red is not; a new detector finding is a veto and an advisory one is not.
- `compare`: the key is random and un-blinds correctly; "before preferred" at one viewport drops the move; a move with no pictures is judged on the detector and audit delta.
- Drop: refused when `HEAD` moved, the tree is dirty, the branch was pushed, or the path is not the run's worktree; the patch exists afterwards.
- Verdict: every row of the table; `unverified` cannot be made ready; `no_change` opens nothing.
- Jev: an uncalibrated answer changes nothing; a calibrated one can cut, reclassify, swap or drop and can never keep or raise; the sent state holds no source, diff, or query string.
- `ship-plan`: 40-line cap; no secret-shaped string; screenshots only when opted in; refused twice for one run.
- Guard: `designer` may edit inside `id-*` and nowhere else new; `design-critic` cannot edit, push or write to GitHub.
- `SKILL.md` documents every command, veto and verdict the script emits, and names no write beyond the list above.

Live-verified on 2026-10-09, on a scratch app: `probe` through `stop` with the real impeccable 4.1.3 detector (baseline scan and per-move delta), real Chrome pictures at both viewports, a kept move, a scope veto with its patch, the verdict, and the six questions against the real Jev API.

Not yet live-verified: real `designer` and `design-critic` agents in the loop (the comparison's quality), the Playwright and agent picture paths, a real push and pull request, and the `design-evidence` push against GitHub.

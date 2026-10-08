---
name: do-shit
description: "Orchestrate GitHub issues, ClickUp tasks or Linear issues (with or without sub-issues/subtasks) end to end: plan with investigators, run role-based subagent teams in a loop driven by a deterministic harness plus Jev judgments, open one PR per leaf item, merge in a safe order after approval, then optionally QA with evidence posted back to the tickets. Use when the user invokes /do-shit with tracker refs or URLs, or asks to resume or check a /do-shit run."
argument-hint: "<ref-or-url> [<more>...] [--dry-run] | resume <run-id> | status [<run-id>]"
---

# /do-shit

**Requires Claude Code.** This skill launches the plugin's bundled role agents through the Agent tool (`subagent_type`) and relies on the plugin's PreToolUse guard. If you cannot spawn a subagent by `subagent_type`, or the role agents are not available, stop and tell the user: "/do-shit needs Claude Code with the real-skills plugin installed." Do not improvise the roles yourself.

You are the **orchestrator**. You never write feature code. A deterministic harness owns state and every loop decision:

```
H="node ${CLAUDE_PLUGIN_ROOT}/skills/do-shit/scripts/harness.mjs"
```

The loop:

1. Run `$H next --run <id>`.
2. Execute **every** action it returns.
3. Record each result with the matching `record*` command.
4. Repeat until `done`.

Do not second-guess the harness. If you think it's wrong, tell the user; don't work around it. Every command prints exactly one JSON object.

**Keep your own output short.** Between gates, say one line per action you execute (`spawned worker #12`, `PR #40 opened`), in the style of `references/report-style.md`. Do not relay agent reports: the harness has them. Gate summaries, the final report, and anything about security or an irreversible step are written in full.

Trackers: `references/trackers/{github,clickup,linear}.md`. Jev catalog: `references/jev-questions.md`.

## Arguments

- `/do-shit <refs…> [--dry-run]` starts a run.
  - Refs are any mix of the forms each adapter's `parse_ref` accepts.
  - All refs must use one tracker.
  - `--dry-run`: the harness, agents, worktrees and scope checks all run for real. Push, PR creation, tracker writes and merges are **logged instead of executed**.
- `/do-shit resume <run-id>`: see Resume.
- `/do-shit status [<run-id>]`: runs `$H status --run <id>` and renders the report. With no id, list the runs in `~/.claude/state/do-shit/`.

## Phase 0 — Intake (you)

1. **Repo.**
   - The run targets the git repo of the cwd: `git rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git$##'`.
   - Not in a repo: stop and say so.
   - A GitHub ref from another repo: stop and tell the user to run it there.
2. **Conventions.** Read the repo's `CLAUDE.md`/`AGENTS.md` for the **verify command**. The user-level `~/.claude/CLAUDE.md` is the fallback, and `.claude/do-shit.json` `verify` overrides both.
3. **Items.** Load the tracker adapter for the refs and follow it: `parse_ref`, then `fetch`, then `children`, recursively.
   - Output `{items, skipped}`, normalized. Only `items` goes to the harness.
   - Tell the user which children were skipped and why.
4. **Base branch.** `git fetch origin <base>` once. Base is `do-shit.json` `base`, else the remote default branch.
5. **Init:**
   ```
   printf '%s' '<{"items":[…]}>' > <scratch>/items.json
   $H init --repo <abs> --base <base> --tracker <github|clickup|linear> --verify "<cmd>" [--dry-run] < <scratch>/items.json
   ```
   Keep `run_id`, and say it once so the user can resume.

**Statuses.** The first `next` after `init` returns `tracker:in_progress` for every item, alongside the investigator spawns: items show In Progress while they're being planned. Items the run later drops get a `tracker:restore` back to their status at init.

## Executing actions

`next` returns `{phase, mode, spawns_used, spawn_cap, actions:[…]}`. Execute every action in the array. Spawns in one array run **in parallel** (background agents). Do tracker, PR, push and merge actions one at a time, in array order.

### `spawn`
Fields: `role`, `subagent_type`, `name`, `leaf`, `loop`, `via`, `prompt_file`.

- **Prompt.** The prompt is the content of `prompt_file`, **verbatim**. Add nothing, and never paste another agent's report into it. The tester's independence depends on this. The prompt already tells the agent to reply with a JSON block only and how long each field may be.
- **`via: "new"`:** use the Agent tool with `subagent_type`, `name`, `description` ("<role> <ref>"), `run_in_background: true`.
- **`via: "message"`:** SendMessage to `name` with the file content. The same agent continues with its context intact.
- **Recording.** When it finishes, pipe its **final message** to:
  ```
  $H record --run <id> --leaf <leaf> --role <role> --agent <name> < <file-with-final-message>
  ```
- **Re-ask (`reask`).** If `record` returns `{"action":"reask","message":…}`, SendMessage that message to the agent, then record **the agent's reply** the same way. Pipe the reply itself, never your own note about it. The harness allows one re-ask, for an invalid report or for one that is over the length caps. A report that is still too long the second time is accepted; only an invalid one fails the role.
- **Role failed (`role_failed`).** A second invalid report returns `{"ok":false,"action":"role_failed",role,error,stored}`. The harness never stores the error text as a plan or contract:
  - team roles: a blocking failure is routed to a fixer (`stored: "report"`);
  - plan-phase investigator: the leaf is excluded (`stored: "none"`);
  - architect: nothing is stored. The first time, the next `next` re-messages the same architect without asking; if that fails too, it returns an `architect_failed` ask.

  Tell the user which role failed and why, then call `next`.
- **Late valid report.** If the agent's valid report shows up after `role_failed`, record it with the same command. It replaces the failure (`"replaced":true`) while nothing has used it yet: the architect or plan-phase investigator until the checkpoint is answered, a team role until its loop is decided. After that, `record` returns `{error}` saying it can't be replaced. A still-invalid replacement returns `{"ok":false,"replaced":false,error}` and changes nothing.
- **Not an error:** `record` may report `scope.ok: false`. The harness has already routed that failure to a fixer.

### `workflow`
Fields: `script_path`, `args`. Only with `plan_workflow: true` in `.claude/do-shit.json`: the plan-phase investigators run as one Workflow instead of one `spawn` each. The harness asked for it, so this is the opt-in the Workflow tool needs.

1. Call the Workflow tool with `scriptPath: <script_path>` and `args` exactly as given (a JSON value, not a string). Add nothing to either.
2. Wait for its completion notification. Never poll.
3. Pipe its result (`{run_id, results}`) to:
   ```
   $H record-batch --run <id> < <file-with-result>
   ```
4. `record-batch` returns `{recorded, fallback}`. Say one line for each `fallback` leaf, then call `next`: it returns a plain `spawn` for those leaves.

If the Workflow tool is missing, disabled or declined, record `{"results":[]}` the same way: every leaf falls back to a plain `spawn`. Don't spawn the investigators yourself before that.

### `wait`
Agents are still running. Wait for their completion notifications, record each one, then call `next` again. Never poll.

### `wait_ci`
Fields: `prs`, `seconds`. CI is still running on PRs the user already approved, and the harness is waiting for it instead of asking.

1. Wait `seconds` once: run `sleep <seconds>` as a background command and continue when it exits. Do not check CI yourself.
2. Record: `$H record-tracker --run <id> --key ci_wait < '{"results":[]}'`, then call `next`. The harness re-checks the PRs.

Dry run: skip the wait and record straight away. When the wait runs past `ci_wait_minutes` (default 20), the harness skips those PRs and the final report says so.

### `ask_user`
The harness decides some gates itself and only asks when it must (see Autonomy under Rules). When it does ask, the payload's `review` says why: the `vetoes` that fired, or `not_auto_because`. Show that line first.

Ask with **one** `AskUserQuestion` call: at most 4 questions, recommended option first. Then run:
```
$H record-answer --run <id> --kind <kind> < answer.json
```
The answer JSON must match the action's `answer_shape`.

| kind | What to show | Answer |
|---|---|---|
| `architect_failed` | The architect failed again after one automatic retry (an invalid report twice, both times): the error, and the leaves that share the contract. Options: retry (the same agent is messaged again), proceed without a shared contract, or cancel the run. Recommend retry. | `{choice:"retry"\|"proceed"\|"cancel"}` |
| `checkpoint` | Per leaf: plan digest (1 line), open questions, risks, roles with reasons. Also: teams/clusters, stacks, waves, warnings, architect contract (or `architect_failed`: say plainly the leaves build without one), `spawn_estimate` vs `spawn_cap`, harness `mode` (say plainly if it's `shadow` or `degraded`), excluded items with the reason, and `review`. | `{proceed, exclude:[], notes:{id:text}, replan:[], spawn_cap}` |
| `merge_approval` | First, `auto_gates`: every gate the harness decided without asking (gate, decision, reason), so the user sees it before anything merges. Then the ordered PR list: PR link, leaf, outcome, loops, roles, stacked_on. Drafts and `agent-tests-failed` PRs are excluded unless the user picks them. | `{merge:"all_green"\|"none"\|[n…], include_drafts:[n…]}` |
| `reapproval` | A fix team changed code beyond a clean rebase: PR, why, and `review`. | `{pr, approve}` |
| `ci_pending` | Only with `autonomy: "off"`. CI is still running on these PRs. Ask whether to continue gating them now (they re-check) or skip them. Don't poll CI yourself. | `{continue}` |
| `qa_approval` | Merged items. Ask: QA needed? Which env? Offer local, preview or staging, from the repo's launch.json, vercel config and docs. **Never offer production.** | `{qa, env, base_url, signed_in}` |
| `offers` | Only when the repo has no `after_qa` setting. Number of bug children filed, and e2e candidates. Ask: run `/do-shit` on the bugs now? Turn passing flows into e2e specs? | `{fix_bugs, e2e}` |

Questions to you, the user, during a run come only through these harness `ask_user` actions. Nowhere else.

- **QA sign-in.** For a remote env, the user signs in first, and you drive the 1Password autofill flow in the built-in browser pane **in the main thread**. Set `signed_in: true` only after you can see the logged-in page. QA agents never type credentials.
- **`offers` answers:**
  - `fix_bugs: true`: after `done`, start a new `/do-shit` run on the new bug children.
  - `e2e: true`: after `done`, start a `/do-shit` run whose single item is "e2e specs for <refs>", scoped to the test-engineer role. Say so at the checkpoint.

### `tracker`
Fields: `key`, `ops[]`. Execute each op through the tracker adapter:

| op | Adapter operation | Notes |
|---|---|---|
| `status` | `status_write` to `to_type` (in_progress, review, qa, done, reopened) | Read the current status first. Skip if the target isn't ahead of it (never backward). `fallback_to_type` applies when the list has no matching status. |
| `restore_status` | `restore_status` to the exact `to_name` | Undoes the run's own in_progress move for an item it dropped (excluded, not started, run cancelled). Read the current status first. Skip unless its class is still `only_if_type` (in_progress): if someone moved it since, leave it. Record with `to_type`. |
| `comment` | `comment` with the content of `body_file` | Replace `{{shot:<path>}}` with the uploaded URL from the preceding `attach`. Terse professional register. |
| `label` | `labels` | Create the label if it's missing; if the tracker can't create it, report it. |
| `attach` | `attach` with `files` | GitHub: push them to the `qa-evidence` branch under `<run_id>/<item>/`. |
| `create_child` | `create_child` under `parent` | Return the new ref in `detail`. |

Then record:
```
$H record-tracker --run <id> --key <key> < results.json
```
`results.json` is `{"results":[{item, op, to_type?, ok, skipped?, detail?}]}`.

A failed tracker write is **never** fatal: record `ok:false` with the error and continue.

`dry_run: true`: don't call the tracker. Print one line per op (`[dry-run] CU-x status → review`) and record `ok:true, detail:"dry-run"`.

### `pr`
Fields: `worktree`, `branch`, `base_branch`, `rebase_onto`, `draft`, `title`, `body_file`, `labels`, `dry_run`.

1. Rebase the branch. In `worktree`: `git fetch origin && git rebase <rebase_onto>`.
   - A conflict here means the plan was stale. Abort the rebase and tell the user.
   - Confirm `git status --porcelain` is empty.
2. Push, one push at a time across teams. Never run two pushes at once:
   ```
   git -C <worktree> push -u origin <branch>
   ```
3. Create the PR:
   ```
   gh pr create --head <branch> --base <base_branch> --title <title> --body-file <body_file> [--draft]
   ```
4. Add labels with `gh pr edit <n> --add-label <l>`, creating any missing label first with `gh label create … || true`.
5. Record:
   ```
   $H record-pr --run <id> --leaf <leaf> --number <n> --url <url> [--draft]
   ```

Dry run: skip steps 1–4, then record `--number 0 --url dry-run`. The harness assigns each leaf a unique synthetic number (9000+); use the numbers it returns in later `merge` actions.

### `push`
A merge-fix team finished.

1. In `worktree`: `git push --force-with-lease origin <branch>`. **Never** a plain `--force`.
2. Record:
   ```
   $H record-push --run <id> --leaf <leaf> --pr <pr>
   ```

### `merge`
1. `gh pr merge <pr> --<method>`. Do **not** pass `--delete-branch` while `then_retarget` is non-empty.
2. For each entry in `then_retarget`, run `gh pr edit <pr> --base <base>` **before** any branch deletion.
3. Record:
   ```
   $H record-merge --run <id> --pr <pr> --result merged|failed --detail "<error>"
   ```

Dry run: record `merged` without calling gh.

### `rerun_checks`
1. `gh run rerun <run-id> --failed`, for each failed Actions run on the PR.
2. Record: `$H record-tracker --run <id> --key rerun:<pr> < '{"results":[]}'`.
3. The harness gates the PR again later. You don't wait for or poll the rerun.

### `done`
Render `report` as the final report:
- a table with one row per leaf: ref (linked), PR (linked), result, statuses, roles
- the merge table
- QA bugs
- harness mode and spawns used out of the cap
- "Decided without asking": one row per entry in `auto_gates` (gate, decision, reason). Omit the table when it is empty
- one line per non-clean outcome saying what a human should do next

Say `shadow`/`degraded` mode plainly.

## Rules

- **Only you write** to trackers, push, open PRs or merge. Agents never do; their definitions forbid it.
- **Role agents.**
  - Resolution (`subagent_type`) comes from the harness.
  - A repo's `.claude/agents/<role>.md` overrides the user-level one, which overrides the bundled plugin agent (`real-skills:<role>`), natively. A prefixed repo agent (e.g. `acme-researcher` for investigator) is used when present.
  - The report contract is in every prompt file, so overrides still return a valid JSON report.
- **Worktrees** live under `<repo>/.claude/worktrees/ds-*`. The harness creates and removes them; don't touch them yourself except for the git commands above.
- **Outward-facing text:**
  - Tracker comments and PR bodies are tight and professional: articles kept, no filler, no hedging. A user-level "outward-facing writing" rule in `~/.claude/CLAUDE.md` wins if present.
  - Security findings and irreversible actions are written in full prose.
- **Cost:** the checkpoint shows `spawn_estimate` against `spawn_cap` (default 60). The harness enforces the cap and finishes in-flight loops. Report partial runs as partial.
- **Autonomy.** The harness asks less when it can decide safely. `.claude/do-shit.json` `autonomy` is `"gates"` (default) or `"off"` (every gate asks).
  - Decided by code alone: the first `architect_failed` (one retry), `ci_pending` (wait up to `ci_wait_minutes`, then skip the PR), `offers` (from `after_qa: {fix_bugs, e2e}` when set).
  - Decided from a Jev answer, and only in `live` mode, with the question calibrated and no veto: `checkpoint` (proceed) and `reapproval` (approve). Vetoes are code: open questions, an excluded item, a security-sensitive area, a migration, planner warnings, an estimate over the cap, a fix that touched files outside the plan, a tester that did not pass.
  - **Never decided for the user:** `merge_approval` and `qa_approval`.
  - Every automatic decision is an `auto_gate` event and a row in the final report. A decision the harness would have made but was not allowed to is a `shadow_gate` event.
- **Harness errors.** A non-zero exit or `{error}` means stop, show the error, and suggest `resume` once it's fixed. Never edit state files by hand.
- **Jev** is called only by the harness: redacted metadata and summaries, never source code. Modes:
  - `shadow`: Jev is logged, and conservative code rules decide.
  - `live`: Jev decides within the code vetoes.
  - `degraded`: the API failed and conservative rules decide.
  - The first 3 real runs stay in `shadow`. Switch to `--mode live` at init only after the user has reviewed the shadow logs (`events.jsonl`).
  - Questions marked uncalibrated in `references/jev-questions.md` are logged and decide nothing, in every mode.

## Resume

1. `$H status --run <id>` shows the phase and pending work.
2. **Reconcile** before continuing:
   - For each pending `spawn`: does the agent still exist (ListAgents)? If yes, wait for it and record it.
   - For a pending `workflow`: if its run finished in this session, record its result with `record-batch`. Otherwise leave it to `reissue`.
   - For each pending `pr` or `merge`: check `gh pr view` / `gh pr list --head <branch>`. If it already happened, record it (`record-pr` / `record-merge`).
   - For each pending tracker key: read the item's current status and record what's actually true.
3. For any other stale pending work, run `$H reissue --run <id>`, which clears in-flight markers and refunds unused spawns.
4. Then continue the `next` loop.

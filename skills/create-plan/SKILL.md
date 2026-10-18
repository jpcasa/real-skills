---
name: create-plan
description: "Turn a spec into an ordered implementation plan an agent executes task by task: files per task, which Done-when items each covers, what can run in parallel, what needs its own review, and the exact command that proves each step. A script checks the plan (header, caps, placeholders, parallel tasks sharing files, uncovered Done-when items, risky files without review); Jev scores tasks that are too big, need review, or have vague steps. Caveman-terse, capped at 8 tasks. Never implements. Use when the user invokes /create-plan or asks for an implementation plan, after /create-spec, or when another skill hands off to it."
argument-hint: "[spec path | brief]"
---

# Create Plan

A plan is for the executor, usually this same session: what to touch, in what order, and the command that proves each step. Not a tutorial.

Never implement from here. Write, check, hand off, stop. Execution starts on the user's go.

## Harness

`S` = this skill's directory (`${CLAUDE_PLUGIN_ROOT}/skills/create-plan` in Claude Code). `H` = `node "$S/scripts/plan.mjs"`. One JSON object out.

- `lint <plan.md> [--spec <spec.md>]`: code only, always counts. Reads the spec named in `Spec:` when `--spec` is absent.
- `judge <plan.md>`: three Jev questions per task, `task_too_big`, `needs_review`, `step_vague`. Each is logged and decides nothing until `/calibrate` switches it on, and then only with `CREATE_PLAN_JEV=live`.
- **`by_hand: true` → apply the By hand rule.** `degraded: true` means Jev is off: say once, no retry. Never act on `shadow`.
- `CREATE_PLAN_JEV`: unset `shadow`, `live`, `0`/`off`. Log: `~/.claude/state/create-plan/jev.jsonl`. Sends goal, task names, file paths and step text to `api.typesafe.ai`, redacted. No source code or secrets in steps.

## 1. Input

- **Spec file** (`docs/specs/…`): read it whole. Its `## Done when` items are `D1`…`Dn` in order. Sliced spec → one plan per slice file; the index's `## Shared` goes under `Constraints`.
- **Brief in chat** (tier 1, `/quick-ask-me`): plan in chat, ≤10 lines, one checkbox per task with its `Run:` command. No file, no lint. Stop.
- **Nothing written, work is tier 2** (new subsystem, shared interface, schema, auth, payments): run `/real-skills:create-spec` first.

Read the code the spec names: patterns to copy, where tests live. Verify command from the repo's `CLAUDE.md`/`AGENTS.md`, `package.json` scripts, `Makefile` or CI workflow. Never guess it; not found → ask once.

## 2. Write

Save `docs/plans/YYYY-MM-DD-<slug>.md` (slug of the spec), or the repo's plan location.

```md
# <Feature> Plan

Spec: `<spec path>`
Goal: <one line>
Verify: `<exact repo command>`
Constraints:
- <version floor, naming rule, global rule: one line each>

## File map
| File | Responsibility |
|---|---|
| `path/a.ts` | <one line> |

## Tasks

### Task 1: <name>
Files: `path/a.ts` (modify), `path/a.test.ts` (create)
Covers: D1,D2 · Parallel: no · Review: no
- [ ] Failing test: <what it asserts>
- [ ] Implement: <what, where>
- [ ] Run: `<exact command>` → pass
- [ ] Commit: `<conventional message>`

## Execution
<from the rules below>
```

- Task = smallest unit a reviewer could reject alone. Fold setup, config, docs into the task that needs them. 3–8 tasks.
- Caps (lint): ≤8 tasks, ≤8 lines per task, ≤25 lines before `## Tasks`. Over → merge tasks, or one plan per spec slice.
- `Covers`: every `D#` by at least one task; `—` for a task covering none (release, cleanup).
- `Parallel: yes` only with no file shared with another `Parallel: yes` task and no other task's output needed. Else `no (after N)`.
- `Review: yes` for auth, schema, migrations, payments, deletion. Lint enforces it by path.
- `Produces: <signature>` line only when a later task uses a new export. Code only for non-obvious interfaces, ≤5 lines.
- No `TBD`, `TODO`, "similar to Task N", "add error handling", "as needed". `Commit: none — <reason>` when nothing to commit.
- Full caveman. **Full prose** for irreversible or order-sensitive steps.

**`## Execution` rules** (write the ones that apply):

- Default: this session, task order, run each `Run:` step; a task is done only with its command output.
- `Parallel: yes` tasks → one `fork` agent each, max 4. Check each agent's diff, not its report.
- `Review: yes` → review that task's diff before the next task builds on it. Otherwise one whole-branch review at the end (`/code-review`).
- Last: the `Verify:` command, output cited.

## 3. Check

```bash
$H lint docs/plans/<file>.md
$H judge docs/plans/<file>.md
```

Fix, re-run; at most 2 passes, then list what is left in the handoff.

| Rule | Fix |
|---|---|
| `missing_header`, `missing_section` | Add `Spec:`, `Goal:`, `Verify:` (command in backticks), `## Tasks`, `## Execution` |
| `missing_field` | Every task: `Files:`, `Covers:`, `Parallel:`, `Review:`, `Run:` (command or `Verify`), `Commit:` |
| `placeholder` | Say exactly what to write, check or run |
| `parallel_overlap` | Order the two tasks: `Parallel: no (after N)` |
| `uncovered`, `bad_covers` | Add the `D#` to a task, add a task, or fix the number |
| `needs_review` | `Review: yes` |
| `over_cap` | Merge tasks, cut steps, shorten the file map, or plan per slice |

`judge`: `too_big: true` → split. `needs_review: true` → `Review: yes`. `vague_steps` → rewrite naming the file, assertion or command.

**By hand** (`by_hand`): `task_too_big` → split when a task holds two behaviours a reviewer could judge apart. `needs_review` → yes for auth, data, payments, personal data, deletion, anything irreversible. `step_vague` → a step naming no file, behaviour, assertion or command gets rewritten.

## Handoff

Print, then stop:

```md
Plan: <path | in chat>
Tasks <n> · parallel <n> · review <n>
Coverage: D1→1,2 · D2→3 …
Unresolved: <problems, or "none">
Next: execute per `## Execution` on your go
```

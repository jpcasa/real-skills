# create-spec + create-plan

Goal: two quick, model-invocable skills other skills hand off to: `/real-skills:create-spec` (goal or brief → terse spec) and `/real-skills:create-plan` (spec → task plan).

## Done when
- [ ] `skills/create-spec/SKILL.md`, `skills/create-plan/SKILL.md` exist, model-invocable, ≤120 lines each
- [ ] `create-spec` from goal or brief: ≤1 question round (≤4, `triage` → `ask` only), spec passes `spec-jev.mjs lint`
- [ ] `spec-jev.mjs size` returns tier 0 | 1 | 2; tier 0 writes nothing, tier 1 spec in chat ≤10 lines, tier 2 file
- [ ] `create-plan` writes `docs/plans/YYYY-MM-DD-<slug>.md`; `plan.mjs lint` clean on it
- [ ] `plan.mjs lint` flags: missing header field, task missing `Files`/`Covers`/`Run`/`Commit`, `TBD`, "similar to Task"
- [ ] `plan.mjs lint` flags: `Parallel: yes` tasks sharing a file, Done-when item no task covers, over cap
- [ ] New Jev questions in `UNCALIBRATED` and calibrate catalog; `sync.test.mjs` green
- [ ] Consumers listed under Integration point at the two skills
- [ ] `node --test skills/*/scripts/test/*.test.mjs && claude plugin validate . --strict` pass

## Decisions
- Home `real-skills` plugin; model-invocable — other skills and agents must call them
- `create-spec` has no script; reuses `ask-and-create-specs/scripts/spec-jev.mjs` (`triage`, `shape`, `lint`, new `size`) — Jev data pools for calibration
- Spec format + Write/Lint rules move to `create-spec`; `ask-and-create-specs` keeps interview, defers to it — one copy of format
- `create-plan` gets `scripts/plan.mjs` (`lint` = code, `judge` = Jev, shadow)
- Plan cap: ≤8 tasks, ≤8 lines per task, header + file map ≤25 lines; sliced spec → one plan per slice
- Tasks cite `Covers: D1,D3` (Done-when index) → coverage is code, not self-check
- `Review: yes` set by code path rule (auth, schema, migrations, payments, deletion); Jev may add, never remove
- Output caveman full; `## Risks` and irreversible steps full prose

## Interfaces
- `spec-jev.mjs size` stdin `{goal, files_guess[], touches[]}` → `{tier, by_hand, scores?}`
- `plan.mjs lint <plan.md> [--spec <spec.md>]` → `{ok, problems[{rule, line, text}]}`
- `plan.mjs judge` stdin `{goal, tasks[{id, files[], steps[]}]}` → `{tasks[{id, too_big, needs_review, vague_steps[]}], by_hand}`
- New Jev keys: `ask-and-create-specs/needs_file`, `create-plan/task_too_big`, `create-plan/needs_review`, `create-plan/step_vague`

## Out of scope
- `do-shit` harness/plan JSON schema, `review-prs`, `fix-ci`, `promote`, `solve-merge-conflicts`, `check-infra-and-migrations`, `changelog`, `improve-design`
- Executing plans (plan's `## Execution` section only says how)

## Seam
- `plan.mjs lint`/`judge`, `spec-jev.mjs size` · `skills/create-plan/scripts/test/plan.test.mjs`, `skills/ask-and-create-specs/scripts/test/spec-jev.test.mjs`

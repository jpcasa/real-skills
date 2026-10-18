# create-spec + create-plan Plan

Spec: `docs/specs/2026-10-18-create-spec-and-plan.md`
Goal: ship `/real-skills:create-spec` + `/real-skills:create-plan`, wire 6 consumers, retire user-level `writing-plans` into plugin.
Verify: `node --test skills/*/scripts/test/*.test.mjs && bash skills/changelog/scripts/test/release-ranges.test.sh && claude plugin validate . --strict`
Constraints:
- Node 20+, no deps. Every harness command prints one JSON object.
- New Jev questions start in `UNCALIBRATED`: logged, decide nothing. By-hand rule in SKILL.md decides.
- `create-plan/scripts/lib/calibration.mjs` is a copy; `sync.test.mjs` pins it. Jev client imported from `do-shit` like `spec-jev.mjs`.
- Release `0.14.0`.

## File map

| File | Responsibility |
|---|---|
| `skills/create-spec/SKILL.md`, `agents/openai.yaml` | Size → ≤1 question round → shape → write → lint. Owns spec format |
| `skills/create-plan/SKILL.md`, `agents/openai.yaml` | Read spec → verify cmd → tasks → `lint` → `judge` → save. Owns plan format + Execution rules |
| `skills/create-plan/scripts/plan.mjs` | `lint`, `judge` |
| `skills/create-plan/scripts/lib/{rules,calibration}.mjs` | Pure lint rules + review path rule; copy |
| `skills/create-plan/scripts/test/plan.test.mjs` | Unit + CLI tests on fixture plans |
| `skills/ask-and-create-specs/scripts/spec-jev.mjs` | + `size` |
| `skills/ask-and-create-specs/SKILL.md` | §4–6 → "follow create-spec"; handoff `Next:` create-plan |
| Consumers | `quick-ask-me`, `wtf`, `qa-this`, `handoff-with-prompt` SKILL.md; `agents/investigator.md` |

Outside: `sync.test.mjs`, `calibrate/scripts/lib/catalog.mjs`, `README.md`, both `plugin.json`, `marketplace.json`, `~/.claude/skills/{writing-plans,brainstorming}`, `~/.claude/CLAUDE.md`.

## Tasks

### Task 1: `spec-jev.mjs size`
Files: `skills/ask-and-create-specs/scripts/spec-jev.mjs`, `.../test/spec-jev.test.mjs`, `skills/calibrate/scripts/lib/catalog.mjs`
Covers: D3,D7 · Parallel: yes · Review: no
- [ ] Failing test: code rule — `touches` hits schema/auth/payments/deletion or `files_guess` >2 → tier 2; 1–2 files, no hit → 1; config/question → 0; Jev `needs_file` logged, may only raise
- [ ] Implement, add `needs_file` to `UNCALIBRATED` + catalog
- [ ] Run: `node --test skills/ask-and-create-specs/scripts/test/*.test.mjs skills/do-shit/scripts/test/sync.test.mjs`
- [ ] Commit: `feat(ask-and-create-specs): add size command`

### Task 2: `create-spec` skill
Files: `skills/create-spec/{SKILL.md,agents/openai.yaml}`, `skills/ask-and-create-specs/SKILL.md`
Covers: D1,D2,D8 · Parallel: no (after 1) · Review: no
- [ ] Move spec template, optional sections, Write rules, lint table from ask-and-create-specs §4–6 verbatim; ask-and-create-specs §4–6 → one line "Follow `create-spec` § Shape → Lint with the brief"
- [ ] New flow: context → `size` → `triage` (one round, ≤4 asks; `assume` rest) → `shape` → write → `lint` (≤2 passes) → handoff `Spec · asked/assumed · Next: /real-skills:create-plan <path>`
- [ ] Input forms: free goal, `quick-ask-me` brief, `wtf` verdict, ticket ref — brief fields map 1:1
- [ ] Run: `wc -l skills/create-spec/SKILL.md` ≤120; Verify
- [ ] Commit: `feat(create-spec): add quick spec skill`

### Task 3: `plan.mjs lint`
Files: `skills/create-plan/scripts/{plan.mjs,lib/rules.mjs}`, `.../test/plan.test.mjs`
Covers: D5,D6 · Parallel: yes · Review: no
- [ ] Failing tests per rule: `missing_header`, `missing_field`, `placeholder`, `parallel_overlap`, `uncovered` (needs `--spec`), `over_cap`, `bad_covers` (cites absent D#)
- [ ] Implement pure rules + CLI; review path rule exported for Task 4
- [ ] Run: `node --test skills/create-plan/scripts/test/*.test.mjs`
- [ ] Commit: `feat(create-plan): add plan lint`

### Task 4: `plan.mjs judge` (Jev)
Files: `skills/create-plan/scripts/{plan.mjs,lib/calibration.mjs}`, `.../test/plan.test.mjs`, `sync.test.mjs`, `calibrate/scripts/lib/catalog.mjs`
Covers: D7 · Parallel: no (after 3) · Review: no
- [ ] Failing test: Jev stubbed off → `by_hand: true`, code `needs_review` still set from path rule; Jev on but uncalibrated → `shadow` only
- [ ] Implement 3 nouls (`task_too_big`, `needs_review`, `step_vague`), log `~/.claude/state/create-plan/jev.jsonl`, `CREATE_PLAN_JEV=off`
- [ ] Register in `sync.test.mjs` UNCALIBRATED map + calibration copy list + catalog
- [ ] Run: Verify · Commit: `feat(create-plan): add Jev judge in shadow`

### Task 5: `create-plan` skill
Files: `skills/create-plan/{SKILL.md,agents/openai.yaml}`
Covers: D1,D4 · Parallel: no (after 4) · Review: no
- [ ] Flow: read spec (or in-chat brief → tier-1 plan in chat ≤10 lines) → verify cmd from repo `CLAUDE.md`/`package.json`, never guessed → write → `lint` → `judge` → fix → save
- [ ] Template = this file's shape (header, file map, tasks with `Covers`/`Parallel`/`Review`)
- [ ] `## Execution`: in-thread default; `fork` agents per `Parallel: yes` group, max 4; per-task review only on `Review: yes`; else one branch review; check diffs not reports
- [ ] By-hand rules for each `judge` key
- [ ] Run: `wc -l` ≤120; Verify · Commit: `feat(create-plan): add plan skill`

### Task 6: wire consumers
Files: `skills/{quick-ask-me,wtf,qa-this,handoff-with-prompt}/SKILL.md`, `agents/investigator.md`
Covers: D8 · Parallel: yes (after 2,5 names fixed) · Review: no
- [ ] `quick-ask-me`: brief `Next:` → `/real-skills:create-plan`; save question → "Save as spec via `/real-skills:create-spec`?"
- [ ] `wtf`: `DEFECT` + `FEATURE_REQUEST` next → also `/real-skills:create-spec <ref>` (wtf still writes nothing)
- [ ] `qa-this` §2: change links `docs/specs/*.md` → seed `criteria` from `## Done when`
- [ ] `handoff-with-prompt`: `Spec:`/`Plan:` paths in file + "read first" in prompt
- [ ] `investigator.md`: item links spec/plan → plan against it, `acceptance_criteria` from Done when, cite path
- [ ] Run: Verify · Commit: `feat: hand off to create-spec and create-plan`

### Task 7: release 0.14.0
Files: `README.md`, `.claude-plugin/{plugin,marketplace}.json`, `.codex-plugin/plugin.json`
Covers: D9 · Parallel: no (last in repo) · Review: no
- [ ] README rows, description, version bump in all manifests
- [ ] Run: Verify · Commit: `chore: release 0.14.0`

### Task 8: retire user-level `writing-plans` (after install)
Files: `~/.claude/skills/{writing-plans,brainstorming}/SKILL.md`, `~/.claude/CLAUDE.md`
Covers: — · Parallel: no · Review: no
- [ ] Back up each to `~/.claude/backups/<file>.create-plan-20261018` first (not git)
- [ ] `writing-plans` → 5-line stub pointing to `/real-skills:create-plan`; `brainstorming` tier 2 → `/real-skills:create-spec`; CLAUDE.md Task sizing + real-skills line
- [ ] Run: `claude plugin update real-skills@jpcasa-skills`, check `gitCommitSha` in `installed_plugins.json` · no commit (not a repo)

## Execution
In-thread. Tasks 1 + 3 parallel-safe (`fork`, 2 agents) — else sequential. One `/code-review` on branch before PR. Task 8 only after PR merged + plugin installed.

# improve-design Plan

Spec: `docs/specs/2026-10-09-improve-design.md`
Goal: add `/real-skills:improve-design`, a design pass on one screen where impeccable supplies the rubric, a script keeps only the moves a blind comparison and the code checks approve, and the run ends in a pushed branch and a pull request.
Verify: `node --test skills/*/scripts/test/*.test.mjs && bash skills/changelog/scripts/test/release-ranges.test.sh && claude plugin validate . --strict`
Constraints:
- Node 20+, no dependencies, ES modules, one JSON object per harness call (as `qa.mjs`, `check.mjs`).
- Works installed as a single folder: carries its own copies of shared files; `sync.test.mjs` keeps them identical.
- Every Jev question ships in `UNCALIBRATED` with a case record and a `catalog.mjs` line. Calibrated, Jev can cut, reclassify, swap or drop; never keep, never raise.
- Writes: one worktree `.claude/worktrees/id-<run-id>`, one branch, one commit per kept move, one push, one pull request, opt-in one push to `design-evidence`. Nothing else, and never a branch it did not create.
- Every git, gh, install, dev-server and detector call goes through `lib/` functions that tests can stub (`IMPROVE_DESIGN_GH_STUB`, `IMPROVE_DESIGN_DETECT`, `IMPROVE_DESIGN_STATE_DIR`).
- Version `0.10.0` in both manifests. If `main` takes `0.10.0` first, use the next minor. (It did: `promote` shipped as `0.10.0`, so this is `0.11.0`.)
- Commits only when the user asks.

## File map

All under `skills/improve-design/` unless a path starts elsewhere.

| File | Responsibility |
|---|---|
| `scripts/lib/moves.mjs` | `COMMANDS`, `kindOf(command)`, `buildMoves(issues, opts)`: validate, merge, rank, cut, preselect |
| `scripts/lib/verdict.mjs` | `VETOES`, `moveDecision(move)`, `verdict(run)`, `draftFor(verdict, mode)` |
| `scripts/lib/compare.mjs` | `assign(pairs, rand)` → blind sheet and key; `unblind(key, answers)` |
| `scripts/lib/detect.mjs` | Locate and run impeccable's `detect.mjs --json`; `keyed(findings)`; `newFindings(before, after)` |
| `scripts/lib/config.mjs` | `.claude/improve-design.json`, defaults, `jevMode`, `parseTarget` (a route, or a file plus a route; never another host) |
| `scripts/lib/probe.mjs` | Package manager, dev script, framework, impeccable path and version, `gh` |
| `scripts/lib/git.mjs` | Worktree and branch create, `changedFiles(sha)`, `pushed(branch)`, `dropHead(run, move)`, push |
| `scripts/lib/dev.mjs` | Free port, install, start (detached, pid recorded), wait for ready path, stop, `copyRefusal`, copy and remove env files |
| `scripts/lib/gates.mjs` | Run each gate, record exit code and a tail of output; `turnedRed(before, after)` |
| `scripts/lib/shots.mjs`, `chrome-shot.mjs` | Take a picture (capture command, Playwright, Chrome over the DevTools pipe); keep one only when the file is inside the run folder; hash; `pairsFor(move)` |
| `scripts/lib/pr.mjs` | Pull-request title and body (40 lines), refusals, `gh pr create`, `gh pr view` |
| `scripts/lib/evidence.mjs` | Opt-in: commit screenshots to the orphan `design-evidence` branch with git plumbing, return raw links |
| `scripts/lib/questions.mjs` | Six Jev questions, `UNCALIBRATED`, `META`, what is sent |
| `scripts/lib/state.mjs` | Run folder, `run.json`, `log.jsonl`, `jev.jsonl` |
| `scripts/lib/{jev.mjs,redact.jq,calibration.mjs,glob.mjs,scrub.mjs,paths.mjs}` | Copies |
| `scripts/improve.mjs` | CLI: `probe start prepare serve detect shoot shots-record brief baseline-record plan approve move-start move-check compare-plan compare-record final ship-plan ship stop outcome stats` |
| `scripts/test/*.test.mjs` | `moves`, `verdict` (with `compare`), `improve` (end to end on a temp repo with stubs), `jev`, `skill` |
| `SKILL.md`, `references/{setup,moves,compare,report-style}.md`, `config.example.json`, `agents/openai.yaml` | The flow, setup, how to write issues and moves, the blind comparison brief, example |
| `agents/design-critic.md` (create) | Read-only role: `critique`, `compare`, `rescore` jobs, JSON only |
| `hooks/guard-roles.mjs`, `skills/do-shit/scripts/test/guard-roles.test.mjs` (modify) | `id-*` worktrees for build roles; `design-critic` read-only |
| `skills/do-shit/scripts/test/sync.test.mjs` (modify) | Copy lists, `sets`, count 37 → 43 (46 after merging `main`, where `promote` added three) |
| `skills/calibrate/scripts/lib/catalog.mjs`, `skills/calibrate/scripts/calibrate.mjs` (modify) | Six lines; where the skill logs |
| `README.md`, `.claude-plugin/{plugin,marketplace}.json`, `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json` (modify) | Docs, descriptions, `0.10.0` |

## Tasks

### Task 1: Move, comparison and verdict rules
Files: `scripts/lib/{moves,verdict,compare}.mjs`, `scripts/test/{moves,verdict}.test.mjs` (create)
Produces: `buildMoves(issues, {maxMoves, direction, auto}) → {moves:[{id, issue, severity, command, alt, kind, intent, element, files, source, selected, skipped?}], cut:[…]}`; `assign(pairs, rand) → {sheet, key}`; `unblind(key, answers) → [{move, viewport, prefers: before|after|same, broke}]`; `moveDecision({check, compare, visual, issueGone, jev}) → {keep, reasons}`; `verdict({moves, baseline, final, detector}) → {verdict, reasons}`; `draftFor`
- [x] Failing tests: ranking (P0 first, detector-backed, audit, rest); two issues on one element and command merge; cut at `maxMoves`; `shift` not preselected and skipped under `auto`; `--direction` forces a move in; unknown command refused; refine before shift. Key is random and un-blinds; "before preferred" at one viewport drops; `broke` with a location drops; a non-visual move is kept only when its issue is gone. Every verdict row; `unverified` cannot be made ready; one heuristic down by one is `mixed`.
- [x] Implement
- [x] Run: `node --test skills/improve-design/scripts/test/{moves,verdict}.test.mjs` → pass

### Task 2: Start and stop
Files: `scripts/lib/{config,probe,git,dev,gates,state,paths,env,glob}.mjs`, `scripts/improve.mjs`, `scripts/test/improve.test.mjs` (create)
Produces: `probe`, `start(input) → {run_id, worktree, branch, base, port, url, gates, mode: rendered|code_only}`, `stop(runId)`; `run.json` shape used by every later task
- [x] Failing tests on a temp repo: config precedence across the fallback files; a production host refused; `dev.copy` refuses a tracked path and removes copies at `stop`; worktree lands in `.claude/worktrees/id-*` on a new branch from the base; `--pr` uses the pull request's head (stubbed `gh`); no `dev` block → `code_only`; a dev server that never answers → `code_only` with the reason; gate baseline recorded; no impeccable → refused.
- [x] Implement
- [x] Run: `node --test skills/improve-design/scripts/test/improve.test.mjs` → pass

### Task 3: Baseline, plan, checkpoint
Files: `scripts/lib/detect.mjs` (create); `improve.mjs` (`detect`, `baseline-record`, `plan`, `approve`); tests in `improve.test.mjs`
Produces: `run.baseline {heuristics, audit, total, max, issues}`, `run.detector.baseline`, `run.moves`, checkpoint text; `approve({run_id, moves, commands?, screenshots})`
- [x] Failing tests: detector output stored keyed by rule and file, advisory separate; a critic report missing a heuristic or with an out-of-range score is refused; `n/a` heuristics lower the maximum; an issue whose file is outside the repo is dropped; checkpoint text lists moves, what was cut and the agent count; `approve` records picks and a changed command; `--auto` selects refine moves only.
- [x] Implement
- [x] Run: `improve.test.mjs` → pass

### Task 4: The move loop
Files: `scripts/lib/shots.mjs` (create); `improve.mjs` (`move-check`, `shots-record`, `compare-plan`, `compare-record`); `git.mjs` (`dropHead`); tests in `improve.test.mjs`
Produces: per move `check {sha, files, out_of_scope, gates, new_findings}`, `shots`, `compare`, `decision`; dropped patch at `<run>/moves/<id>.patch`
- [x] Failing tests: a file outside `ui_paths` is a veto; a gate that turns red is a veto and one already red is not; a new detector finding is a veto and an advisory one is not; no commit is a drop; a screenshot path outside the run folder is dropped; `compare-plan` never names which side is newer; a vetoed move skips the comparison; drop is refused when `HEAD` moved, the tree is dirty, the branch was pushed, or the path is not the run's worktree; the patch exists afterwards and `HEAD` is the parent.
- [x] Implement
- [x] Run: `improve.test.mjs` → pass

### Task 5: Final and ship
Files: `scripts/lib/{pr,evidence}.mjs` (create); `improve.mjs` (`final`, `ship-plan`, `ship`); tests in `improve.test.mjs`
Produces: `run.final`, `run.verdict`, `run.pr {url, draft}`
- [x] Failing tests: every verdict from recorded state; `no_change` opens nothing and says why; body is at most 40 lines before screenshot lines, has no secret-shaped string, lists kept, dropped and skipped moves; draft rule per verdict and `pr.draft`; `ship` refused twice, refused when `HEAD` is not the last kept move, refused under `--no-pr`; screenshots only when opted in; push goes to the run's branch only.
- [x] Implement
- [x] Run: `improve.test.mjs` → pass

### Task 6: Jev, outcome, stats, calibrate wiring
Files: `scripts/lib/{questions,jev,calibration,scrub}.mjs`, `redact.jq`, `scripts/test/jev.test.mjs` (create); `improve.mjs` (`plan` and `compare-record` ask; `outcome`, `stats`); `skills/calibrate/scripts/lib/catalog.mjs`, `skills/do-shit/scripts/test/sync.test.mjs` (modify)
- [x] Failing tests: an uncalibrated answer changes nothing; calibrated, `move_worth_doing` cuts, `changes_visual_identity` reclassifies and lets `--auto` run a shift, `alternative_fits_better` swaps, `is_improvement` and `harms_another_state` drop; none can keep a vetoed move or raise a verdict; sent state holds no source, diff or query string; checkpoint answers write labels; `outcome` on a merged pull request labels kept moves; sync test at 43.
- [x] Implement
- [x] Run: `node --test skills/*/scripts/test/*.test.mjs` → pass

### Task 7: Critic role and guard
Files: `agents/design-critic.md` (create); `hooks/guard-roles.mjs`, `skills/do-shit/scripts/test/guard-roles.test.mjs` (modify)
Parallel: yes
- [x] Failing tests: `designer` may edit inside `.claude/worktrees/id-*`, still not outside a worktree; `design-critic` cannot edit, push or write to GitHub.
- [x] Implement
- [x] Run: `node --test skills/do-shit/scripts/test/guard-roles.test.mjs` → pass

### Task 8: Skill text, docs, manifests
Files: `SKILL.md`, `references/*`, `config.example.json`, `agents/openai.yaml`, `scripts/test/skill.test.mjs` (create); README and manifests (modify)
- [x] Failing test: `SKILL.md` names every command, veto and verdict the script emits, and no write beyond the list in Constraints.
- [x] Write; bump `0.11.0`
- [x] Run: full Verify line → pass

### Task 9: Real runs
- [x] `probe` through `stop` on a scratch app with the real impeccable detector, real Chrome and the real Jev API. Fixed what it showed: Chrome cropped the narrow viewport instead of reflowing it (`lib/chrome-shot.mjs`).
- [ ] One full run on a real screen of a real repo with the user's approval at the checkpoint: real designer and critic agents, ending in a real pull request.

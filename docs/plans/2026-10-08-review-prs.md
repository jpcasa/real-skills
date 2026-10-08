# review-prs Plan

Spec: docs/specs/2026-10-08-review-prs.md
Goal: ship `/real-skills:review-prs`, GitHub PR review whose findings are checked, deduplicated, refuted and scored by a script, and posted only on approval.
Verify: `node --test skills/*/scripts/test/*.test.mjs && bash skills/changelog/scripts/test/release-ranges.test.sh && claude plugin validate . --strict`
Constraints:
- Node 20+, zero npm dependencies, ES modules, one JSON object on stdout per call.
- `skills/review-prs/` is self-contained: own `jev.mjs`, `redact.jq`, `calibration.mjs`, `paths.mjs`, `report-style.md` (identical copies, pinned by `sync.test.mjs`).
- The script never trusts a claim it can check: `record` re-verifies every citation, including the refuter's; `post` rebuilds the payload from run state, never from its input.
- The only GitHub write is `post`, and its event is always `COMMENT`.
- Nothing from a PR is checked out or executed. `gh` and `git` calls go through one module so tests can stub them (`REVIEW_PRS_GH_STUB`).
- Jev input holds titles, bodies, paths and `problem` lines only. All four questions ship in `UNCALIBRATED`; when calibrated they may add a lens, hide a nit or merge duplicates, never drop a bug, risk or security finding.

## File map

- `skills/review-prs/SKILL.md`: flow, commands, verdicts, severities, lenses, posting rule, Codex path.
- `skills/review-prs/config.example.json`, `skills/review-prs/agents/openai.yaml`.
- `skills/review-prs/references/report-style.md` (copy), `references/lenses/{correctness,standards,security,data,performance,accessibility}.md`.
- `skills/review-prs/schemas/findings.schema.json`: reviewer and refuter reply shapes.
- `skills/review-prs/workflows/review.js`: per-PR pipeline, lens agents then refuter.
- `skills/review-prs/scripts/review.mjs`: CLI (`start`, `record`, `post-plan`, `post`, `outcome`, `stats`).
- `skills/review-prs/scripts/lib/`: `github.mjs` (gh + git reads, the one write, stub seam), `diff.mjs` (patch parsing, hunks, ignores, chunks), `lenses.mjs` (path rules, lens choice), `rules.mjs` (citation, in-diff, already-raised, dedup, refutation, nit budget, verdict), `post.mjs` (payload, refusals, comment text), `prompts.mjs`, `questions.mjs` (Jev), `state.mjs`, `config.mjs`, plus the copies.
- `skills/review-prs/scripts/test/{rules,review,workflow}.test.mjs`.
- `agents/reviewer.md` (create). `hooks/guard-roles.mjs` (modify: `reviewer` in `READ_ONLY`).
- `skills/do-shit/scripts/test/{sync,agents,guard-roles}.test.mjs` (modify). `skills/calibrate/scripts/calibrate.mjs` (modify: skill list).
- `README.md`, `.claude-plugin/{plugin,marketplace}.json`, `.codex-plugin/plugin.json`: new skill, version `0.7.0`.

## Tasks

### Task 1: Pure libraries
Files: lib/{diff,lenses,rules,config}.mjs, test/rules.test.mjs
Produces:
```
parsePatch(text)                      -> [{file, old_file?, hunks: [{new_start, new_lines, lines: [{n, kind}]}], added, removed}]
isIgnored(path, extraGlobs)           -> bool
chunk(files, {limit: 1500, max: 4})   -> {chunks: [[file]], not_reviewed: [file]}
pickLenses({files, pathRules, forced}) -> {lenses: [name], reasons: {name: why}}
checkFinding(f, {files, headText})    -> {...f, verified, in_diff, problem?}
applyRules({findings, refutations, existing, maxNits}) -> {kept, outside_diff, dropped: {citation, already_raised, duplicate, refuted, nit_budget}}
verdict({kept, outside_diff, partial}) -> {verdict, partial, counts}
```
Parallel: no
- [x] Failing tests: every "Tests that must exist" line for citation, in-diff, already-raised, dedup, nit budget, refutation, verdict, lens choice and large diffs.
- [x] Implement.
- [x] Run: `node --test skills/review-prs/scripts/test/rules.test.mjs` → pass
- [x] Commit: `feat(review-prs): diff parsing, finding rules, lens choice and verdict`

### Task 2: CLI, GitHub reads, run state, prompts
Files: scripts/review.mjs, lib/{github,state,prompts}.mjs, lib copies, schemas/findings.schema.json, test/review.test.mjs
Produces: `start` → `{run_id, prs: [{number, title, head_sha, lenses, chunks, skipped?}], agents: [{pr, lens, agent_type, name, prompt_file}], estimate}`; `record` (stdin `{results: [{pr, lens, report}], refutations: [{pr, report}]}`) → `{prs: [{number, verdict, partial, ci, lines: [chat line], dropped, would_post}]}`
Parallel: no
- [x] Failing tests (temp git repo, `gh` stubbed): refs, URLs and the no-argument search resolve; drafts and closed PRs skipped with a reason; over 10 refused; head files and `diff.patch` written under the run folder and nothing checked out; `record` runs Task 1's rules end to end; a missing lens report makes that PR `partial`; an invalid report is rejected with the schema error.
- [x] Implement.
- [x] Run: review-prs tests → pass
- [x] Commit: `feat(review-prs): harness CLI, PR fetch without checkout, record`

### Task 3: Reviewer agent, guard, lenses, workflow
Files: agents/reviewer.md, hooks/guard-roles.mjs, references/lenses/*.md, workflows/review.js, test/workflow.test.mjs, do-shit test/{agents,guard-roles}.test.mjs
Produces: workflow args `{run_id, agents: [...], refute: bool}` → `{run_id, results, refutations}`, the stdin of `record`
Parallel: no
- [x] Failing tests: guard denies `reviewer` an edit, a push and an `rm`; the `reviewer` agent file is read-only (checked in `review.test.mjs`); workflow against stubs runs one agent per PR per lens, calls the refuter only for a PR with a bug, returns `null` reports without throwing, and its `meta` is a pure literal.
- [x] Write the six lens checklists from the matching role agents' Scope and Method sections, minus everything about worktrees and running code.
- [x] Implement.
- [x] Run: review-prs and do-shit tests → pass
- [x] Commit: `feat(review-prs): reviewer agent, lens checklists, review workflow`

### Task 4: Posting
Files: lib/post.mjs, scripts/review.mjs, lib/github.mjs, test/review.test.mjs
Produces: `post-plan --run --pr` → `{allowed, refused?, payload}`; `post --run --pr` → `{ok, review_id, url}`
Parallel: no
- [x] Failing tests: payload event is `COMMENT` and cannot be overridden by any flag or input; one inline comment per in-diff finding with `path`, `line`, `side`; out-of-diff findings and drop counts in the body; refused on a moved head, a second post, a closed PR; `post` sends exactly what `post-plan` showed.
- [x] Implement.
- [x] Run: review-prs tests → pass
- [x] Commit: `feat(review-prs): post one COMMENT review per PR, with refusals`

### Task 5: Jev, calibration cases, outcome, stats
Files: lib/questions.mjs, scripts/review.mjs, skills/calibrate/scripts/calibrate.mjs, test/review.test.mjs
Parallel: no
- [x] Failing tests: Jev state holds no diff text and no `quote`; each question writes a case record in the shared shape; uncalibrated answers change no line of `record`'s output; a calibrated `finding_is_actionable` hides a nit and never a bug; `outcome` labels a finding whose line changed and not one whose line did not; `stats` reads the log; `calibrate` lists `review-prs`.
- [x] Implement.
- [x] Run: full node suite → pass
- [x] Commit: `feat(review-prs): Jev questions logged for calibration, outcome and stats`

### Task 6: Skill text and plugin wiring
Files: SKILL.md, config.example.json, agents/openai.yaml, sync.test.mjs, README.md, manifests
Parallel: no
- [x] Doc-pin test: `SKILL.md` names every command, verdict, severity and lens the script emits, and no GitHub write other than `post`.
- [x] `SKILL.md`: flow, the workflow launch and its two fallbacks, the single posting question, the Codex path.
- [x] Sync test covers the copies. README: row after `do-shit`, section, three smaller tables, layout, agent count, when to use it versus the built-in review. Version `0.6.0`.
- [x] Run: full Verify → pass
- [x] Commit: `feat: add review-prs to the plugin, release 0.7.0`

### Task 7: Real run and review
- [x] One real run on an open PR (this one, #10), printed only: `start` skips merged PRs by design. Findings fixed; see the spec.
- [ ] One real `post` after approval. Confirm the review on GitHub is `COMMENT` and the lines match. Not done: needs the user's go-ahead.
- [ ] Live check of the reviewer role guard. Needs the plugin installed at this version.

## Self-check

1. Spec sections → tasks: 1 flow (T2, T6), 2 harness (T2), 3 lenses (T1 choice, T3 text and agent), 4 findings and rules (T1), 5 fan-out (T3, T6 fallbacks), 6 posting (T4), 7 Jev (T5), 8 learning loop (T5), 9 config (T1), wiring (T6), real runs (T7).
2. Names match: `start`'s `agents[]` is the workflow's `args.agents`; the workflow's return is `record`'s stdin; `record`'s `would_post` is what `post-plan` rebuilds.
3. No parallel tasks: every task touches `review.mjs` or its tests.
4. Stricter than the spec, on purpose: `post` rebuilds the payload from run state instead of accepting one.

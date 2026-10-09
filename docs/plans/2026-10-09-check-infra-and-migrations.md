# check-infra-and-migrations Plan

Spec: `docs/specs/2026-10-09-check-infra-and-migrations.md`
Goal: add `/real-skills:check-infra-and-migrations`, a script-computed verdict and runbook for the migrations and infrastructure changes a PR or promotion carries, with opt-in live reads, shadow Jev questions and one PR comment on approval.
Verify: `node --test skills/*/scripts/test/*.test.mjs && bash skills/changelog/scripts/test/release-ranges.test.sh && claude plugin validate . --strict`
Constraints:
- Node 20+, no dependencies, ES modules, one JSON object per harness call (as `review.mjs`, `qa.mjs`).
- Works installed as a single folder: carries its own copies of shared files; `sync.test.mjs` keeps them identical.
- Every Jev question ships in `UNCALIBRATED` with a case record and a `catalog.mjs` line. Jev can only make a verdict worse.
- Never applies, deploys, merges, pushes or checks out. The only write is one PR comment.
- Version `0.9.0` in both manifests. If `main` takes `0.9.0` first, use the next minor.
- Commits only when the user asks.

## File map

All under `skills/check-infra-and-migrations/` unless a path starts elsewhere.

| File | Responsibility |
|---|---|
| `scripts/lib/sql.mjs` | `splitStatements(text)`, `classify(stmt)`: one rule and one normalized line per statement |
| `scripts/lib/rules.mjs` | `RULES` (severity, sentence, reversible), `SEVERITIES`, `VERDICTS`, `verdict()` |
| `scripts/lib/migrations.mjs` | Per-file findings (SQL and DSL patterns), history rules, Drizzle journal, deploy window |
| `scripts/lib/infra.mjs` | Diff-text rules for IaC, pipeline and env example files |
| `scripts/lib/diff.mjs` | `parsePatch(text)` keeping added and removed lines with line numbers |
| `scripts/lib/buckets.mjs` | `bucketOf(file, layout)`: `migration`, `infra`, `pipeline`, `env`, or none |
| `scripts/lib/config.mjs` | Three-file precedence, defaults, live command guard, `jevMode` |
| `scripts/lib/probe.mjs` | Migration tool and dir, IaC tool and paths, how each is applied, env files, targets |
| `scripts/lib/github.mjs` | `gh` and `git` reads, the one comment write, `CHECK_INFRA_GH_STUB` |
| `scripts/lib/live.mjs` | Run `applied`, `sizes`, `plan`; parse each; plan preconditions |
| `scripts/lib/cite.mjs` | `checkCitation(finding, headText)` |
| `scripts/lib/runbook.mjs` | Before, order, after, rollback; 20-line cap |
| `scripts/lib/questions.mjs` | Five Jev questions, `UNCALIBRATED`, what is sent |
| `scripts/lib/post.mjs` | Comment body (40 lines), refusals |
| `scripts/lib/state.mjs` | Run folder, `run.json`, `log.jsonl`, `jev.jsonl` |
| `scripts/lib/{jev.mjs,redact.jq,calibration.mjs,glob.mjs,scrub.mjs,paths.mjs}` | Copies (`paths.mjs` as in `review-prs`) |
| `scripts/check.mjs` | CLI: `probe start live record post-plan post outcome stats` |
| `scripts/test/*.test.mjs` | `sql`, `rules` (migrations, infra, buckets, verdict, runbook), `live`, `check` (end to end on a temp repo), `skill` |
| `SKILL.md`, `references/{setup,what-to-check,report-style}.md`, `config.example.json`, `agents/openai.yaml` | The flow, setup, what the agent reads for, example |
| `skills/do-shit/scripts/test/sync.test.mjs` (modify) | Copy lists, `sets`, count 32 → 37 |
| `skills/calibrate/scripts/lib/catalog.mjs` (modify) | Five lines |
| `README.md`, `.claude-plugin/{plugin,marketplace}.json`, `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json` (modify) | Docs, descriptions, `0.9.0` |

## Tasks

### Task 1: Statement and resource rules
Files: `scripts/lib/{sql,rules,migrations,infra,diff,buckets}.mjs`, `scripts/test/{sql,rules}.test.mjs` (create); `glob.mjs` (copy)
Produces: `splitStatements(text) → [{text, skeleton, line}]`; `classify(stmt) → [{rule, table?, column?, object?, normalized}]`; `RULES`; `verdict({findings, unchecked}) → {verdict, counts}`; `fileFindings(file, text, ctx)`; `historyFindings(ctx)`; `infraFindings(fileDiff, headText, ctx)`; `parsePatch`; `bucketOf`
- [x] Failing tests: every SQL rule in spec §4; `CONCURRENTLY`; a `DROP` inside a string, comment and dollar body; unknown statement `unparsed`; normalized line has no literal; index and FK on a table created in the same range are notes; drop-then-create of one policy is a note; edited base migration, out-of-order, journal mismatch; each infra rule on CDK and Terraform samples; a moved declaration does not fire; egress `0.0.0.0/0` does not fire; env name added; every verdict row.
- [x] Implement
- [x] Run: `node --test skills/check-infra-and-migrations/scripts/test/{sql,rules}.test.mjs` → pass

### Task 2: Harness start
Files: `scripts/lib/{config,probe,github,state,paths}.mjs`, `scripts/check.mjs`, `scripts/test/check.test.mjs` (create)
Produces: `start(input)`, `probe`; run state with per-target `buckets`, `findings`, `statements`, `unchecked`
- [x] Failing tests on a temp repo with a stubbed `gh`: a PR, a promotion PR, `promotion` with none open, a range, no arguments, six targets refused; config precedence; setup needed only when `migrations` and `infra` are both unanswered; nothing bucketed → `nothing_to_check`; `still_referenced` attaches hits.
- [x] Implement
- [x] Run: `node --test skills/check-infra-and-migrations/scripts/test/check.test.mjs` → pass

### Task 3: Live reads
Files: `scripts/lib/live.mjs`, `scripts/test/live.test.mjs` (create); `check.mjs` (`live`)
Produces: `commandRefusal(cmd)`, `parseApplied`, `parseSizes`, `parsePlan(text) → {tool, counts, resources}`, `live(input)`
- [x] Failing tests: refused without `confirmed`; ` apply` refused at load; `plan` skipped on a dirty tree and another `HEAD`; a failing command is an unchecked reason; `applied` marks pending and `target_ahead`; a Drizzle hash matches; `sizes` raises a lock rule; CDK and Terraform plan samples give the right counts and stateful blockers.
- [x] Implement
- [x] Run: `node --test skills/check-infra-and-migrations/scripts/test/live.test.mjs` → pass

### Task 4: Record, runbook, post
Files: `scripts/lib/{cite,runbook,post}.mjs` (create); `check.mjs` (`record`, `post-plan`, `post`); tests in `check.test.mjs`, `rules.test.mjs`
Produces: `record(input)` → verdict, lines, runbook per target; `postPlan`, `post`
- [x] Failing tests: wrong quote dropped; an agent finding cannot lower a rule hit; `safe` impossible with an `unparsed` statement or an unplanned infra change; runbook cap, env step, backup step and rollback line; comment cap, no secret-shaped string, refused for a range, moved head, second post, `post: off`.
- [x] Implement
- [x] Run: both test files → pass

### Task 5: Jev, outcome, stats, calibrate wiring
Files: `scripts/lib/{questions,jev,calibration,scrub}.mjs`, `redact.jq`; `check.mjs` (`outcome`, `stats`); `skills/calibrate/scripts/lib/catalog.mjs`, `skills/do-shit/scripts/test/sync.test.mjs` (modify)
- [x] Failing tests: an uncalibrated answer changes nothing; a calibrated one raises and never lowers; sent state holds no literal, hunk or host; `outcome` writes a `safe_to_push` label; sync test at 37.
- [x] Implement
- [x] Run: `node --test skills/*/scripts/test/*.test.mjs` → pass

### Task 6: Skill text, docs, manifests
Files: `SKILL.md`, `references/*`, `config.example.json`, `agents/openai.yaml`, `scripts/test/skill.test.mjs` (create); README and manifests (modify)
- [x] Failing test: `SKILL.md` names every command, verdict and rule the script emits.
- [x] Write; bump `0.9.0`
- [x] Run: full Verify line → pass

### Task 7: Real runs
- [x] Static run on a merged promotion of a Drizzle + CDK repo and on a Supabase repo, read-only, nothing posted. Fix what they show.
- [ ] One run with a `live` command configured against a real environment, and one real `post`, both with the user's approval.

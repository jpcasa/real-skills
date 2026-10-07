# Compressed reports and Jev-driven gates Plan

Spec: docs/specs/2026-10-07-caveman-jev-all-skills.md
Goal: every skill uses bundled compressed-report rules and a Jev-fed deterministic gate layer; the README says so last.
Verify: `node --test skills/*/scripts/test/*.test.mjs && bash skills/changelog/scripts/test/release-ranges.test.sh && claude plugin validate . --strict`
Constraints:
- Node 20+, zero npm dependencies, ES modules, one JSON object on stdout per CLI call.
- Each skill folder is self-contained (Codex copies them alone). No imports across skills.
- New Jev questions are `calibrated: false`: logged, never deciding, until flipped by hand.
- `merge_approval` and `qa_approval` are never auto-decided.
- Length caps never fail a role.

## File map

do-shit
- `skills/do-shit/references/report-style.md` (create): the compressed-report rule.
- `skills/do-shit/scripts/lib/caps.mjs` (create): `checkCaps(text, report)` → `{ok, over:[{field,len,cap}]}`.
- `skills/do-shit/scripts/lib/prompts.mjs` (modify): append the rule, JSON-only report contract.
- `skills/do-shit/scripts/lib/questions.mjs` (modify): `planReview`, `fixScope` builders, thresholds, `UNCALIBRATED`.
- `skills/do-shit/scripts/lib/autonomy.mjs` (create): pure gate deciders `checkpointGate`, `reapprovalGate`, `ciPendingGate`, `offersGate`, plus `autonomyOn`.
- `skills/do-shit/scripts/harness.mjs` (modify): caps re-ask in `record`; auto checkpoint; architect auto-retry; `recordAutoGate`.
- `skills/do-shit/scripts/lib/merge.mjs` (modify): auto reapproval, ci_pending, offers; `auto_gates` in merge_approval payload and final report.
- `skills/do-shit/scripts/lib/repo.mjs` (modify): document new config keys.
- `skills/do-shit/schemas/state.schema.json` (modify): `auto_gates`.
- `skills/do-shit/scripts/gen-jev-doc.mjs` (modify) → regenerates `references/jev-questions.md`.
- `skills/do-shit/SKILL.md` (modify): terse status lines, auto gates, report shape.
- Tests: `caps.test.mjs`, `autonomy.test.mjs` (create); `harness.test.mjs` (extend).

changelog
- `skills/changelog/scripts/lib/{jev.mjs,redact.jq,paths.mjs}` (create): client copy + own redact path.
- `skills/changelog/scripts/lib/rules.mjs` (create): `resolveTicket`, `flags` (pure code).
- `skills/changelog/scripts/judge.mjs` (create): CLI over rules + Jev.
- `skills/changelog/scripts/test/judge.test.mjs` (create).
- `skills/changelog/references/report-style.md` (create, identical copy).
- `skills/changelog/SKILL.md`, `references/setup.md`, `config.example.json` (modify).

quick-ask-me
- `skills/quick-ask-me/scripts/lib/{jev.mjs,redact.jq,paths.mjs}` (create).
- `skills/quick-ask-me/scripts/gate.mjs` (create): `questions | criteria | stop`.
- `skills/quick-ask-me/scripts/test/gate.test.mjs` (create).
- `skills/quick-ask-me/references/report-style.md` (create, identical copy).
- `skills/quick-ask-me/SKILL.md` (modify).

Repo
- `skills/do-shit/scripts/test/sync.test.mjs` (create): byte-identity of `jev.mjs`, `redact.jq`, `report-style.md` copies.
- `README.md`, `.claude-plugin/plugin.json` description (modify, last).

## Tasks

### Task 1: Compressed reports in do-shit
Files: references/report-style.md, lib/caps.mjs, lib/prompts.mjs, harness.mjs (`cmdRecord`), test/caps.test.mjs, test/harness.test.mjs
Produces: `checkCaps(text, report)`; `CAPS`; event `verbose_report`
Parallel: no
- [ ] Failing tests: over-cap `summary` → `{action:"reask"}` naming the field; second over-cap is stored with a `verbose_report` event; `security-advisor` exempt; auditor finding with `security: true`… (schema has no such field: exemption keys on text starting `SECURITY:`); prose above the block over 200 chars triggers the re-ask.
- [ ] Implement. Caps are checked only on a schema-valid report, and share the single `entry.reasked`.
- [ ] Run: `node --test skills/do-shit/scripts/test/*.test.mjs` → pass
- [ ] Commit: `feat(do-shit): compressed role reports with length caps`

### Task 2: Gate deciders and plan-phase autonomy
Files: lib/questions.mjs, lib/autonomy.mjs, harness.mjs (plan phase, checkpoint, architect retry), lib/repo.mjs, schemas/state.schema.json, test/autonomy.test.mjs, test/harness.test.mjs
Produces:
```
autonomyOn(run, config)            -> bool   (config.autonomy !== 'off' && run.mode === 'live')
decides(jev, id)                   -> bool   (not degraded, id not in UNCALIBRATED, answer is a number)
checkpointGate({run, config, jev}) -> { auto: bool, would: bool, vetoes: [str], p }
recordAutoGate(run, {gate, decision, reason, jev, vetoes})   pushes run.auto_gates, appends auto_gate event
```
`would` is the decision ignoring calibration and mode; when `would && !auto` the harness logs `shadow_gate` and asks.
Parallel: no
- [ ] Failing tests: clean live run with `plan_needs_human_review` calibrated (test hook `DO_SHIT_CALIBRATED=plan_needs_human_review,…`) skips the checkpoint and goes to build; each veto alone forces the ask; shadow, degraded, `autonomy:"off"`, and uncalibrated all ask and log `shadow_gate` when `would`; first architect failure auto-retries without an ask, second asks.
- [ ] Implement.
- [ ] Run: do-shit tests → pass
- [ ] Commit: `feat(do-shit): harness can pass the checkpoint and retry the architect`

### Task 3: Merge-side gates and reporting
Files: lib/autonomy.mjs, lib/merge.mjs, harness.mjs (`cmdRecordPush`), test/autonomy.test.mjs, test/harness.test.mjs
Produces: `reapprovalGate`, `ciPendingGate({entry, now, minutes})`, `offersGate(config)`; `report.auto_gates`; merge_approval `payload.auto_gates`
Parallel: no
- [ ] Failing tests: reapproval auto-approves only when tester passed, fix files ⊆ plan files, no migration, no security findings, Jev above threshold and calibrated; ci_pending continues under `ci_wait_minutes` and skips with a reason after; offers uses `after_qa` when set and still asks when unset (spec default "both false" applies only when the key is present… see self-check); `merge_approval` and `qa_approval` still emit `ask_user` in every mode.
- [ ] Implement.
- [ ] Run: do-shit tests → pass
- [ ] Commit: `feat(do-shit): harness decides reapproval, pending CI and offers`

### Task 4: Jev catalog, SKILL.md
Files: scripts/gen-jev-doc.mjs, references/jev-questions.md (regenerated), SKILL.md
Parallel: no
- [ ] gen-jev-doc lists the two new questions and marks uncalibrated ones.
- [ ] SKILL.md: one-line status rule; gates table notes which may be auto-decided; `done` report renders "Decided without asking"; config keys.
- [ ] Run: do-shit tests (skill.test pins the catalog and documented kinds) → pass
- [ ] Commit: `docs(do-shit): document auto-decided gates and report style`

### Task 5: changelog judge
Files: as in file map
Produces: `judge.mjs` stdin `{pr:{number,title,body,branch,labels,files}, tracker:{id_pattern}, areas, mode}` → `{number, ticket, ticket_source, candidates, flags:{migration,docs_only,default_on_change}, area, mode, jev:{…}}`
Parallel: yes (no shared files with tasks 1–4, 6)
- [ ] Failing tests: branch ID beats body ID; `Fixes X` in body wins over later IDs; several bare body IDs and no branch → `null`; returned ticket always ∈ candidates; migration and docs-only by path; no key → `mode:"degraded"`, Jev fields `null`; uncalibrated Jev answers are reported under `jev` but do not change `ticket`/`area`.
- [ ] Implement; SKILL.md Phase 1 (`default_audience`), Phase 3 (run judge, one-line notes, paths-only), data-leaves-machine note; setup.md; config example.
- [ ] Run: `node --test skills/changelog/scripts/test/*.test.mjs && bash skills/changelog/scripts/test/release-ranges.test.sh` → pass
- [ ] Commit: `feat(changelog): deterministic ticket and flag rules with Jev judgments`

### Task 6: quick-ask-me gate
Files: as in file map
Produces: `gate.mjs questions|criteria|stop`, stdin JSON → `{ask, lookup, skip, mode}` / `{criteria:[{text, observable, p}], mode}` / `{stop, missing:[…], mode}`
Parallel: yes
- [ ] Failing tests: `ask` never exceeds 6; degraded → every candidate in `ask` (up to 6), none skipped; calibrated live stub routes lookup/skip/ask; `stop` is false while any of the five conditions is missing; uncalibrated answers never move a question out of `ask`.
- [ ] Implement; SKILL.md: run the gate, "Assumed without asking" line in the brief, two-sentence questions, data note.
- [ ] Run: `node --test skills/quick-ask-me/scripts/test/*.test.mjs` → pass
- [ ] Commit: `feat(quick-ask-me): gate candidate questions through Jev`

### Task 7: Sync test, README, manifest
Files: skills/do-shit/scripts/test/sync.test.mjs, README.md, .claude-plugin/plugin.json
Parallel: no
- [ ] Sync test: three `jev.mjs`, three `redact.jq` (incl. `hooks/lib`), three `report-style.md` byte-identical.
- [ ] README: "How these skills work" section (compressed reports, Jev + harness, what is decided today vs logged), per-skill updates, config keys, requirements, data that leaves the machine.
- [ ] Run: full Verify line → pass
- [ ] Commit: `docs: describe compressed reports and Jev-driven gates`

### Task 8: Whole-branch review
- [ ] `cavecrew-reviewer` on `git diff jpcasa/readme-skills-docs-8e9c01...HEAD`; fix confirmed findings; rerun Verify.

## Self-check

1. Spec coverage: A → T1, T5, T6; B → T5, T6, T7; C → T2, T3, T4; D → T5; E → T6; README → T7.
2. Deviations from the spec, deliberate:
   - Caps live in `caps.mjs`, not as `maxLength` in the schema: exemptions depend on role, which a schema cannot express.
   - `offers`: auto only when `after_qa` is present in config. With the key absent the gate still asks, so existing repos keep today's behaviour.
   - Auditor security exemption keys on a `SECURITY:` text prefix; the report schema has no security flag.
3. Names match across tasks (`recordAutoGate`, `auto_gates`, `UNCALIBRATED`, `decides`).

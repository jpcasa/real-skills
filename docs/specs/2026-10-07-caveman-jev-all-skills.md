# Compressed reports and Jev-driven gates in every skill

Date: 2026-10-07 · Branch: `jpcasa/caveman-jev-all-skills` (stacked on `jpcasa/readme-skills-docs-8e9c01`, PR #1)

## Goal

Every skill in the plugin (`do-shit`, `changelog`, `quick-ask-me`) uses two shared mechanisms, and the README says so only once it is true:

1. **Compressed reports** (caveman-style): what agents and scripts hand back to the main context is short and structured, so long runs do not drown in prose.
2. **Jev-driven decisions**: typed Jev judgments, checked by code thresholds and vetoes, decide the things a human is asked today when the answer is predictable. The human is asked only when a veto fires or Jev is unsure.

Quality bar: no decision becomes automatic without a code veto list, a calibrated threshold, and a log entry the user can audit.

## Terms

- **Harness**: deterministic code. Same inputs and same Jev answers give the same decision.
- **Jev**: probabilistic. It returns a number or a choice; it never decides alone. "Jev as the harness" in conversation means "the harness decides from Jev answers".
- **Gate**: a point where the skill asks the human.
- **Veto**: a code rule that forces a gate to ask, whatever Jev says.

## Non-goals

- Auto-merge. `merge_approval` stays human. So does `qa_approval` (choice of environment, sign-in).
- Depending on the external caveman skill or plugin. The rules are bundled; caveman is credited.
- Compressing anything a teammate reads: tracker comments, PR bodies, the changelog file, the quick-ask-me brief. Those keep their current register.
- Compressing security findings. `security-advisor` output stays full prose.
- New Jev question types going live without calibration. They start in `shadow`.
- A cross-skill shared library. Codex installs copy each skill folder alone, so each skill stays self-contained.

## Approach

### A. Compressed reports

One rule file per skill, `references/report-style.md`, same text in all three (a test pins them identical):

- Fragments allowed, no filler, no restating the task, no narration of process.
- Exact strings stay exact: paths, `file:line`, commands, error text, IDs.
- Security, data loss and irreversible actions: full sentences.

**do-shit**

- `prompts.mjs` appends the rule to every role prompt and changes the report contract: the final message is the JSON block only, no prose above it.
- `validate` gains length caps, checked at `record`:

  | Field | Cap |
  |---|---|
  | text outside the JSON block | 200 chars |
  | `summary` | 300 chars |
  | `findings[].text` | 240 chars |
  | each item in `plan.files / acceptance_criteria / test_plan / risks / open_questions` | 200 chars |
  | `plan.summary` | 600 chars |

  Exempt: every field of a `security-advisor` report, any finding from `auditor` flagged as security, `qa.walkthrough` (it is posted to the ticket).
- Over a cap: the existing single re-ask is used, with the offending fields named. A second over-cap report is **accepted**, not failed, and logged as `verbose_report`. Length never fails a role.
- `SKILL.md`: orchestrator status lines between gates are one line per action. Gate summaries and the final report keep their current shape.

**changelog**

- `SKILL.md`: per-PR working notes are one line each (`#n | area | ticket | flags | summary`) until render. `gh pr view` drops `files` from the default JSON and fetches paths only (`--json files --jq '.files[].path'`), since file bodies are never used.

**quick-ask-me**

- `SKILL.md`: each question is at most two sentences plus the recommended answer; looked-up facts are one line each. The closing brief is unchanged.

### B. Jev client per skill

- `skills/<skill>/scripts/lib/jev.mjs` and `skills/<skill>/scripts/lib/redact.jq` in `changelog` and `quick-ask-me`, byte-identical copies of the `do-shit` client and `hooks/lib/redact.jq`. A test fails when a copy drifts.
- Same modes everywhere: `shadow` (Jev logged, fallback decides), `live` (Jev decides inside vetoes), `degraded` (no key, API failure, Node missing: fallback decides). No key means today's behaviour, unchanged.
- New questions carry a per-question `calibrated: false` flag in the catalog. An uncalibrated question is treated as `shadow` even when the run is `live`: logged, never deciding. Flipping the flag is the explicit step that lets it decide. So on day one, the Jev-decided gates (`checkpoint`, `reapproval`) and the Jev fields in `judge.mjs` and `gate.mjs` still fall back; the code-only ones (`ci_pending`, `offers`, `architect_failed` retry, `default_audience`, ticket and flag rules) take effect immediately.
- Each new script is a CLI that reads JSON on stdin and prints one JSON object, like `harness.mjs`.

### C. do-shit: gates the harness may decide

New config key `autonomy` in `.claude/do-shit.json`: `"gates"` (default) or `"off"`. Auto-decisions apply only when `autonomy` is `"gates"`, mode is `live`, and Jev is not degraded. Otherwise every gate asks as it does today.

| Gate | Auto-decision | Decided by | Vetoes (any one forces the ask) |
|---|---|---|---|
| `checkpoint` | proceed | New Jev question `plan_needs_human_review` (noul) below threshold | any `open_questions`; any `premise_valid: false`; any excluded or skipped item; planner warnings; `architect_failed`; `spawn_estimate > spawn_cap`; a leaf with `security-advisor` in its roles; a migration file in any plan; `other_repo` or `uncovered_parent_work` set |
| `reapproval` | approve | New Jev question `fix_stays_within_item_scope` (noul) above threshold **and** the tester passed on the fix loop | fix diff touches a file outside the plan's `files`; `security-advisor` findings on the fix; migration file changed |
| `ci_pending` | continue | Code only: keep gating while under `ci_wait_minutes` (new config, default 20) since first seen pending; then skip the PR and report it | none |
| `offers` | take config | Code only: new config `after_qa: {fix_bugs, e2e}`, default both `false` | none |
| `architect_failed` | retry once, then ask | Code only | second failure always asks |
| `merge_approval`, `qa_approval` | never | | always ask |

- Every auto-decision appends an `auto_gate` event (`gate`, `decision`, `jev` answers, `vetoes_checked`) to `events.jsonl`.
- The final report gains a "Decided without asking" table: gate, decision, reason. `merge_approval` shows the same table first, so the human sees what was auto-decided before anything merges.
- In `shadow`, the harness records what it would have auto-decided (`shadow_gate` event) and still asks. That is the calibration data.
- `scripts/eval/run.mjs` and `references/jev-questions.md` gain the two new questions. Thresholds start at `0.3` (`plan_needs_human_review`, biased to ask) and `0.7` (`fix_stays_within_item_scope`, biased to ask) until fixtures exist.

### D. changelog: `scripts/judge.mjs`

Input: one PR's title, body, branch, labels, file paths, plus `tracker.id_pattern` and `areas`. Output: one JSON object.

| Field | Fallback (no Jev) | With Jev (`live`) |
|---|---|---|
| `ticket` | Code: ID in branch name wins; else first ID after `Fixes/Closes/Resolves/<Tracker>:` in the body; else `null` | Same code result. When the body cites several IDs and the branch has none, Jev noul `id_is_this_prs_own_ticket` per candidate; below threshold gives `null` ("no ticket linked") |
| `flags.migration` | Code: path matches the migration pattern | Same |
| `flags.docs_only` | Code: every path is docs | Same |
| `flags.default_on_change` | `null`, the model judges as today | Jev noul `changes_live_behaviour_without_opt_in` |
| `area` | `null`, the model infers as today | Jev choice among `areas` when `areas` is set |

- Gate removed: new config `default_audience`. When set and no audience argument is given, the skill does not ask. Setup offers to set it.
- The script decides facts and labels only. The summary sentences are still written by the model from the PR body.
- Rejected ticket guesses stay rejected: the script can only return an ID that appears in the PR's own branch or body.

### E. quick-ask-me: `scripts/gate.mjs`

The model drafts candidate questions; the script decides which reach the human.

- `gate.mjs questions`: input `{objective, criteria, candidates:[{id, text, recommended}], facts}`. Per candidate, two Jev nouls: `repo_can_answer_this` (look it up instead) and `answer_changes_what_gets_built` (else skip). Output `{ask:[ids], lookup:[ids], skip:[ids]}`, capped at the existing budget of 6.
- `gate.mjs criteria`: per success criterion, Jev noul `criterion_is_observable`. Below threshold: the skill pushes once for a checkable version (existing rule, now triggered by the score instead of model judgment).
- `gate.mjs stop`: early stop is code over the five existing conditions, with the two judgment ones (`scope boundary named`, `seam known`) from Jev nouls.
- Unchanged: Q1 objective and Q2 success criteria always go to the human. The final "good enough to implement?" confirmation stays. Skipped questions are listed in the brief under a new line, "Assumed without asking", with the recommended answer taken.
- Fallback (no key, no Node): today's behaviour, model judgment within the same budget.
- `disable-model-invocation: true` stays.

### Rejected alternative

**Depend on the installed caveman skill and let Jev replace the gates outright.** Less code, but nothing would be enforced: users without caveman get no compression, and a gate decided by one uncalibrated probability with no veto list is how a wrong plan gets built unattended. The bundled-rule-plus-veto design costs more code and keeps a failure visible.

## Interfaces and data changes

- `report.schema.json`: no shape change. Caps live in `validate.mjs` (schema subset has no `maxLength`; add it there and to the schema).
- `do-shit.json`: new optional keys `autonomy`, `ci_wait_minutes`, `after_qa`.
- `changelog.json`: new optional key `default_audience`.
- `state.schema.json`: `auto_gates[]` on the run; `ci_first_pending_at` per merge entry.
- New files: `skills/changelog/scripts/judge.mjs`, `skills/quick-ask-me/scripts/gate.mjs`, the two `lib/jev.mjs` + `lib/redact.jq` copies, three `references/report-style.md`.
- Requirements: Node 20+ becomes "needed for Jev in any skill"; without Node, `changelog` and `quick-ask-me` run as they do today.
- Redaction: now four copies of `redact.jq` (repo `hooks/lib`, two skill copies, plus the user-level one outside this repo). The sync test covers the three in the repo.

## Risks

- **Uncalibrated questions.** Six new Jev questions have no fixtures. Mitigation: all ship in `shadow`; thresholds biased toward asking; `live` for them is a later, explicit change after reviewing `shadow_gate` events.
- **Auto-checkpoint builds a wrong plan.** Mitigation: veto list above, spawn cap still enforced, and `merge_approval` remains a human gate with the auto-decisions shown first. Worst case is wasted spawns, not merged code.
- **Caps cut real information.** Mitigation: over-cap is never a failure; security is exempt; exact strings are not subject to rewording, only total length.
- **More data leaves the machine.** changelog sends PR titles, bodies and paths; quick-ask-me sends the objective and candidate questions. Same redaction as do-shit, never source code. README and each SKILL.md must state this plainly.
- **Copies drift.** Mitigation: byte-identity tests.
- **Stacked branch.** This branch sits on PR #1. Rebase onto `main` once #1 merges.

## Verification

```bash
node --test skills/do-shit/scripts/test/*.test.mjs
node --test skills/changelog/scripts/test/*.test.mjs
node --test skills/quick-ask-me/scripts/test/*.test.mjs
bash skills/changelog/scripts/test/release-ranges.test.sh
claude plugin validate . --strict
```

New tests, by area:

- Caps: over-cap report triggers one re-ask; second over-cap is accepted with a `verbose_report` event; `security-advisor` is exempt.
- Each gate: auto-decides in `live` with clean inputs; each veto alone forces the ask; `shadow` and `degraded` always ask; `autonomy: "off"` always asks.
- `merge_approval` and `qa_approval` are never auto-decided (asserted for every mode).
- `judge.mjs`: branch ID beats body ID; several body IDs and no branch ID gives `null` in fallback; an ID not present in the PR is never returned.
- `gate.mjs`: budget of 6 holds; fallback output with no key; Q1 and Q2 are never in `skip`.
- Sync: `jev.mjs`, `redact.jq`, `report-style.md` copies are byte-identical.
- `do-shit --dry-run` on a real ticket in `shadow`, then read `events.jsonl` for `shadow_gate` entries.

README "How these skills work" section is the last commit, after all of the above pass.

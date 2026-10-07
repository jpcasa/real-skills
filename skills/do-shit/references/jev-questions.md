# Jev question catalog

Generated from `scripts/lib/questions.mjs` by `node scripts/gen-jev-doc.mjs`. Do not edit by hand.

Code owns every decision; these answers feed policy in `scripts/lib/policy.mjs`, `scripts/lib/merge.mjs` and `scripts/lib/autonomy.mjs`. Thresholds are defaults until `harness eval` calibrates them.

A question listed in `UNCALIBRATED` has no eval fixtures yet. Its answer is logged (`jev` and `shadow_gate` events) and decides nothing, in every mode. Removing it from that set, after `harness eval` has data for it, is what lets it decide.

| Threshold key | Value |
|---|---|
| `needs_role` | 0.45 |
| `shares_interface` | 0.6 |
| `overlap` | 0.5 |
| `depends_on` | 0.6 |
| `same_failure_as_last_loop` | 0.3 |
| `plan_is_wrong` | 0.6 |
| `ci_failure_unrelated_to_pr` | 0.3 |
| `open_review_comments_blocking` | 0.5 |
| `behavior_changed_after_rebase` | 0.5 |
| `failure_is_regression_of_item` | 0.6 |
| `plan_needs_human_review` | 0.3 |
| `fix_stays_within_item_scope` | 0.7 |

## Role pick (per leaf) — phase: plan

### `needs_data-engineer` (noul, threshold 0.45)

Does this work item need changes to the database schema, migrations, row-level security policies, or seed data? Judge from `item`, `plan` and, when present, `failures` from the last review.

- **yes:** The plan or item adds/alters tables, columns, indexes, constraints, RLS policies, migrations, or seed data.
- **no:** No persistent data shape or access-policy change; queries against existing schema only.

### `needs_designer` (noul, threshold 0.45)

Does this work item change something a user sees in the interface: layout, components, styling, visual states, or interaction? Judge from `item`, `plan` and, when present, `failures` from the last review.

- **yes:** New or changed screens, components, forms, empty/error/loading states, styling, or motion.
- **no:** Backend-only, data-only, tooling, or invisible refactor with no visual or interaction change.

### `needs_content-creator` (noul, threshold 0.45)

Does this work item add or change user-facing text: UI copy, labels, messages, emails, translations, or changelog entries? Judge from `item`, `plan` and, when present, `failures` from the last review.

- **yes:** New or edited strings a user reads, i18n keys, notification or email text, release notes.
- **no:** No user-readable text changes, or only developer-facing strings like logs.

### `needs_observability-engineer` (noul, threshold 0.45)

Does this work item add a new user flow, background job, or integration that should be instrumented with error tracking, analytics events, or logs? Judge from `item`, `plan` and, when present, `failures` from the last review.

- **yes:** New flow, job, webhook, or external call whose failures or usage the team would want to see.
- **no:** Small change inside an already-instrumented path, or purely internal refactor.

### `needs_docs-writer` (noul, threshold 0.45)

Does this work item change developer-facing interfaces or conventions that are documented, such as APIs, config, setup steps, architecture decisions, or agent instructions? Judge from `item`, `plan` and, when present, `failures` from the last review.

- **yes:** Public or internal API, env/config, setup, conventions, or ADR-worthy decisions change.
- **no:** No documented interface or convention changes.

### `needs_test-engineer` (noul, threshold 0.45)

Does this work item need dedicated test-writing beyond what the implementer normally adds: missing coverage flagged by review, complex logic, or end-to-end flows? Judge from `item`, `plan` and, when present, `failures` from the last review.

- **yes:** Reviewers flagged coverage gaps, or the change has branching logic or a multi-step flow with no existing tests.
- **no:** Existing tests cover it, or the change is trivial enough that implementer tests suffice.

### `needs_auditor` (noul, threshold 0.45)

Would this work item benefit from a standards-and-spec review of the diff before it ships: non-trivial size, touches shared code, or has acceptance criteria easy to miss? Judge from `item`, `plan` and, when present, `failures` from the last review.

- **yes:** Multi-file change, shared modules, or several acceptance criteria to check against.
- **no:** Tiny isolated change with one obvious acceptance criterion.

### `needs_security-advisor` (noul, threshold 0.45)

Does this work item touch authentication, authorization, payments, row-level security, secrets, personal data, or data deletion? Judge from `item`, `plan` and, when present, `failures` from the last review.

- **yes:** Login/session/token logic, permission checks, billing, RLS, credentials, PII handling, or deleting user data.
- **no:** None of those areas are touched.

### `needs_accessibility-auditor` (noul, threshold 0.45)

Does this work item change interactive UI where keyboard access, focus order, screen-reader labels, or color contrast could regress? Judge from `item`, `plan` and, when present, `failures` from the last review.

- **yes:** New or changed interactive controls, dialogs, forms, menus, or color/typography.
- **no:** No interactive UI change.

### `needs_performance-engineer` (noul, threshold 0.45)

Could this work item noticeably affect performance: database queries over many rows, lists or tables, heavy rendering, bundle size, or hot request paths? Judge from `item`, `plan` and, when present, `failures` from the last review.

- **yes:** New or changed queries, pagination, large lists, data-heavy views, new dependencies, or code on hot paths.
- **no:** Small, bounded change off any hot path.

## Architect trigger — phase: plan

### `shares_interface` (noul, threshold 0.6)

Do two or more of the `leaves` depend on the same new or changed interface (a shared type, API contract, database table, or component props) that should be designed once before they are built in parallel?

- **yes:** At least two leaves produce or consume the same new/changed contract, so building them separately risks incompatible shapes.
- **no:** Leaves are independent, or only share existing unchanged interfaces.

## Pairwise overlap + dependency (per pair i<j) — phase: plan

### `overlap__0__1` (score, threshold 0.5)

How much will implementing `leaves[0]` and `leaves[1]` touch the same code?

0. Separate areas: no shared files or modules.
1. Same module or feature area, but different files.
2. Same files, functions, or components will be edited by both.

### `depends__0__1` (noul, threshold 0.6)

Does implementing `leaves[1]` require code that `leaves[0]` adds, so `leaves[1]` cannot be built or tested until `leaves[0]` exists?

- **yes:** `leaves[1]` uses a function, type, table, endpoint, or component that only `leaves[0]` creates.
- **no:** They can be built independently, even if they touch related areas.

### `depends__1__0` (noul, threshold 0.6)

Does implementing `leaves[0]` require code that `leaves[1]` adds, so `leaves[0]` cannot be built or tested until `leaves[1]` exists?

- **yes:** `leaves[0]` uses a function, type, table, endpoint, or component that only `leaves[1]` creates.
- **no:** They can be built independently, even if they touch related areas.

## Checkpoint review (only when no veto fires) — phase: plan

### `plan_needs_human_review` (noul, threshold 0.3, **uncalibrated: logged, never decides**)

Before any code is written, does a person need to review the plans in `leaves`? Judge whether each `plan_summary` clearly does what its `title`, `body` and `acceptance_criteria` ask, with nothing ambiguous, risky or out of scope.

- **yes:** At least one plan is ambiguous, misreads its item, leaves an acceptance criterion uncovered, changes more than the item asks, carries a serious risk, or depends on a product decision nobody has made.
- **no:** Every plan is a direct, bounded implementation of its item, and the listed risks are routine.

## Loop decision (only when review failed) — phase: build

### `same_failure_as_last_loop` (noul, threshold 0.3)

Are `current_failures` essentially the same problems as `previous_failures`, meaning the last fix attempt did not resolve them?

- **yes:** The same root problems recur, possibly reworded or in the same files.
- **no:** The failures are new or different, or previous ones were resolved.

### `plan_is_wrong` (noul, threshold 0.6)

Do `current_failures` show that the approach in `plan` is wrong for `item`, rather than the implementation having fixable bugs?

- **yes:** Failures trace back to a wrong premise, wrong files, wrong architecture, or acceptance criteria the plan misread.
- **no:** The plan is sound; failures are implementation bugs, missing tests, or small omissions.

### `next_action` (choice, threshold —)

Given `item`, `plan`, `review_summary` and `current_failures`, what should the team do next?

- **ship:** All reviewers passed and no blocking findings remain.
- **fix:** There are concrete, fixable failures the build roles can address in another loop.
- **replan:** The plan itself is wrong and needs to be redone before more building.
- **escalate:** A human decision is needed: ambiguity, missing access, or a product call.

## Merge gate (only when CI red or comments open) — phase: merge

### `ci_failure_unrelated_to_pr` (noul, threshold 0.3)

Are the failing checks in `ci.failed_checks` unrelated to the changes in `pr` (flaky tests, infrastructure, timeouts, rate limits)?

- **yes:** Failures are in areas the PR does not touch, or show flaky/infra signatures.
- **no:** Failures plausibly come from the PR changes.

### `open_review_comments_blocking` (noul, threshold 0.5)

Do any of the unresolved `review_comments` request a change that must be made before merging?

- **yes:** At least one comment asks for a real change, flags a bug, or explicitly blocks.
- **no:** Remaining comments are nits, questions already answered, praise, or optional suggestions.

### `behavior_changed_after_rebase` (noul, threshold 0.5)

Comparing `rebase.before_summary` and `rebase.after_summary`, did rebasing or conflict resolution change what the PR does, beyond mechanically applying it on the new base?

- **yes:** Conflict resolution altered logic, dropped or added behavior, or changed tests.
- **no:** Pure rebase: same behavior on a newer base.

## Fix scope (a merge fix changed an approved PR, no veto fired) — phase: merge

### `fix_stays_within_item_scope` (noul, threshold 0.7, **uncalibrated: logged, never decides**)

A pull request for `item` was already approved for merge. Then `fix` was applied to it. Does `fix` only do what `fix.asked` required, staying inside what `item` and `plan` describe?

- **yes:** The fix addresses the listed problems and nothing else: no new behavior, no unrelated files, no removed tests.
- **no:** The fix adds or removes behavior beyond what was asked, touches unrelated areas, or weakens tests.

## QA failure (per failed step) — phase: qa

### `failure_is_regression_of_item` (noul, threshold 0.6)

Is the failure in `qa_step` caused by the changes made for `item` (described in `merged_diff_summary`), rather than a pre-existing bug or an environment problem?

- **yes:** The failing behavior is in the area the item changed and plausibly results from those changes.
- **no:** The failure is in unrelated functionality, existed before, or is caused by environment/data/setup.

## Calibration (`harness eval`)

30 fixtures from a private repo's history, 0 errors. Eval "current" is the threshold at eval time; the table at the top is what the harness uses.

| Family | n | positives | threshold at eval | accuracy there | best plateau | best F1 / accuracy |
|---|---|---|---|---|---|---|
| `same_failure_as_last_loop` | 5 | 3 | 0.3 | 1 | 0.3–0.3 | 1 / 1 |
| `plan_is_wrong` | 8 | 3 | 0.6 | 0.875 | 0.3–0.75 | 0.8 / 0.875 |
| `open_review_comments_blocking` | 4 | 2 | 0.5 | 1 | 0.3–0.8 | 1 / 1 |
| `ci_failure_unrelated_to_pr` | 6 | 3 | 0.3 | 1 | 0.3–0.35 | 1 / 1 |
| `depends_on` | 14 | 3 | 0.6 | 1 | 0.3–0.7 | 1 / 1 |
| `overlap` | 7 | 3 | 0.5 | 1 | 0.3–0.8 | 1 / 1 |
| `needs_role` | 44 | 18 | 0.45 | 0.977 | 0.45–0.45 | 0.971 / 0.977 |

Notes: `same_failure_as_last_loop` (n=5) and `open_review_comments_blocking` (n=4) are thin; `plan_is_wrong` misses a true positive at p=0.24 (one private PR: the ticket targeted the smaller problem), so consider rewording it. Re-run `harness eval` after adding fixtures from real /do-shit shadow runs.

// Jev question catalog for /do-shit. Mirrors references/jev-questions.md.
// Each builder returns { state, questions } for ONE Jev request. Question IDs
// are for code only (never sent to the model), so every instruction carries
// its full meaning. Thresholds calibrated 2026-09-28 with `harness eval` over 30
// private-repo fixtures (scripts/eval/results.json); see references/jev-questions.md.

import * as C from './calibration.mjs';

export const DEFAULT_THRESHOLD = 0.6;

export const THRESHOLDS = {
  needs_role: 0.45,
  shares_interface: 0.6,
  overlap: 0.5, // normalized Score 0..1
  depends_on: 0.6,
  same_failure_as_last_loop: 0.3,
  plan_is_wrong: 0.6,
  ci_failure_unrelated_to_pr: 0.3,
  open_review_comments_blocking: 0.5,
  behavior_changed_after_rebase: 0.5,
  failure_is_regression_of_item: 0.6,
  // Uncalibrated, both biased toward asking the user.
  plan_needs_human_review: 0.3, // auto-proceed only below
  fix_stays_within_item_scope: 0.7, // auto-approve only at or above
};

// Questions with no eval fixtures yet. Their answers are logged and never
// decide anything, whatever the run mode. Removing an id here, after
// `harness eval` has data for it, is the step that lets it decide.
export const UNCALIBRATED = new Set(['plan_needs_human_review', 'fix_stays_within_item_scope']);
// DO_SHIT_TEST_CALIBRATED is for the test suite only. On a user's machine a
// question leaves that state through /calibrate, which writes an entry for it
// (lib/calibration.mjs) and may move its threshold. The file is consulted for
// these ids only: nothing else in the harness can be switched from it.
const SKILL = 'do-shit';
const forTests = (id) => (process.env.DO_SHIT_TEST_CALIBRATED || '').split(',').includes(id);
export const isCalibrated = (id) => !UNCALIBRATED.has(id) || forTests(id) || C.isOn(SKILL, id);
export const thresholdOf = (id) => (UNCALIBRATED.has(id) ? C.threshold(SKILL, id, THRESHOLDS[id]) : THRESHOLDS[id]);
// One decision in ten of a question switched on by /calibrate still asks the
// user, so its right answers keep arriving.
export const spotChecked = (id, caseId) => UNCALIBRATED.has(id) && !forTests(id) && C.isOn(SKILL, id) && C.spotCheck(caseId);

// Roles the harness may add per loop. Core (investigator/worker/tester),
// architect (via shares_interface), integrator and QA roles are not here.
export const OPTIONAL_ROLES = {
  'data-engineer': {
    ask: 'Does this work item need changes to the database schema, migrations, row-level security policies, or seed data?',
    yes: 'The plan or item adds/alters tables, columns, indexes, constraints, RLS policies, migrations, or seed data.',
    no: 'No persistent data shape or access-policy change; queries against existing schema only.',
  },
  designer: {
    ask: 'Does this work item change something a user sees in the interface: layout, components, styling, visual states, or interaction?',
    yes: 'New or changed screens, components, forms, empty/error/loading states, styling, or motion.',
    no: 'Backend-only, data-only, tooling, or invisible refactor with no visual or interaction change.',
  },
  'content-creator': {
    ask: 'Does this work item add or change user-facing text: UI copy, labels, messages, emails, translations, or changelog entries?',
    yes: 'New or edited strings a user reads, i18n keys, notification or email text, release notes.',
    no: 'No user-readable text changes, or only developer-facing strings like logs.',
  },
  'observability-engineer': {
    ask: 'Does this work item add a new user flow, background job, or integration that should be instrumented with error tracking, analytics events, or logs?',
    yes: 'New flow, job, webhook, or external call whose failures or usage the team would want to see.',
    no: 'Small change inside an already-instrumented path, or purely internal refactor.',
  },
  'docs-writer': {
    ask: 'Does this work item change developer-facing interfaces or conventions that are documented, such as APIs, config, setup steps, architecture decisions, or agent instructions?',
    yes: 'Public or internal API, env/config, setup, conventions, or ADR-worthy decisions change.',
    no: 'No documented interface or convention changes.',
  },
  'test-engineer': {
    ask: 'Does this work item need dedicated test-writing beyond what the implementer normally adds: missing coverage flagged by review, complex logic, or end-to-end flows?',
    yes: 'Reviewers flagged coverage gaps, or the change has branching logic or a multi-step flow with no existing tests.',
    no: 'Existing tests cover it, or the change is trivial enough that implementer tests suffice.',
  },
  auditor: {
    ask: 'Would this work item benefit from a standards-and-spec review of the diff before it ships: non-trivial size, touches shared code, or has acceptance criteria easy to miss?',
    yes: 'Multi-file change, shared modules, or several acceptance criteria to check against.',
    no: 'Tiny isolated change with one obvious acceptance criterion.',
  },
  'security-advisor': {
    ask: 'Does this work item touch authentication, authorization, payments, row-level security, secrets, personal data, or data deletion?',
    yes: 'Login/session/token logic, permission checks, billing, RLS, credentials, PII handling, or deleting user data.',
    no: 'None of those areas are touched.',
  },
  'accessibility-auditor': {
    ask: 'Does this work item change interactive UI where keyboard access, focus order, screen-reader labels, or color contrast could regress?',
    yes: 'New or changed interactive controls, dialogs, forms, menus, or color/typography.',
    no: 'No interactive UI change.',
  },
  'performance-engineer': {
    ask: 'Could this work item noticeably affect performance: database queries over many rows, lists or tables, heavy rendering, bundle size, or hot request paths?',
    yes: 'New or changed queries, pagination, large lists, data-heavy views, new dependencies, or code on hot paths.',
    no: 'Small, bounded change off any hot path.',
  },
};

const noul = (instructions, yes, no) => ({
  type: 'noul',
  instructions,
  criteria: { true: yes, false: no },
});

// state: { item: {title, body, acceptance_criteria}, plan: {summary, files[]}, failures?: [{role, text}] }
export function roleNeeds(state) {
  const questions = {};
  for (const [role, q] of Object.entries(OPTIONAL_ROLES)) {
    questions[`needs_${role}`] = noul(
      `${q.ask} Judge from \`item\`, \`plan\` and, when present, \`failures\` from the last review.`,
      q.yes,
      q.no,
    );
  }
  return { state, questions };
}

// state: { leaves: [{id, title, body, plan_summary, files[]}] }
export function sharesInterface(state) {
  return {
    state,
    questions: {
      shares_interface: noul(
        'Do two or more of the `leaves` depend on the same new or changed interface (a shared type, API contract, database table, or component props) that should be designed once before they are built in parallel?',
        'At least two leaves produce or consume the same new/changed contract, so building them separately risks incompatible shapes.',
        'Leaves are independent, or only share existing unchanged interfaces.',
      ),
    },
  };
}

// Pairwise overlap + dependency in one request. pairs: [[i, j]] indexes into state.leaves.
export function pairwise(state, pairs) {
  const questions = {};
  for (const [i, j] of pairs) {
    questions[`overlap__${i}__${j}`] = {
      type: 'score',
      instructions: `How much will implementing \`leaves[${i}]\` and \`leaves[${j}]\` touch the same code?`,
      criteria: [
        'Separate areas: no shared files or modules.',
        'Same module or feature area, but different files.',
        'Same files, functions, or components will be edited by both.',
      ],
    };
    questions[`depends__${i}__${j}`] = noul(
      `Does implementing \`leaves[${j}]\` require code that \`leaves[${i}]\` adds, so \`leaves[${j}]\` cannot be built or tested until \`leaves[${i}]\` exists?`,
      `\`leaves[${j}]\` uses a function, type, table, endpoint, or component that only \`leaves[${i}]\` creates.`,
      'They can be built independently, even if they touch related areas.',
    );
    questions[`depends__${j}__${i}`] = noul(
      `Does implementing \`leaves[${i}]\` require code that \`leaves[${j}]\` adds, so \`leaves[${i}]\` cannot be built or tested until \`leaves[${j}]\` exists?`,
      `\`leaves[${i}]\` uses a function, type, table, endpoint, or component that only \`leaves[${j}]\` creates.`,
      'They can be built independently, even if they touch related areas.',
    );
  }
  return { state, questions };
}

// state: { item, plan, loop, current_failures: [...], previous_failures: [...], review_summary }
export function loopDecision(state) {
  return {
    state,
    questions: {
      same_failure_as_last_loop: noul(
        'Are `current_failures` essentially the same problems as `previous_failures`, meaning the last fix attempt did not resolve them?',
        'The same root problems recur, possibly reworded or in the same files.',
        'The failures are new or different, or previous ones were resolved.',
      ),
      plan_is_wrong: noul(
        'Do `current_failures` show that the approach in `plan` is wrong for `item`, rather than the implementation having fixable bugs?',
        'Failures trace back to a wrong premise, wrong files, wrong architecture, or acceptance criteria the plan misread.',
        'The plan is sound; failures are implementation bugs, missing tests, or small omissions.',
      ),
      next_action: {
        type: 'choice',
        instructions:
          'Given `item`, `plan`, `review_summary` and `current_failures`, what should the team do next?',
        criteria: {
          ship: 'All reviewers passed and no blocking findings remain.',
          fix: 'There are concrete, fixable failures the build roles can address in another loop.',
          replan: 'The plan itself is wrong and needs to be redone before more building.',
          escalate: 'A human decision is needed: ambiguity, missing access, or a product call.',
        },
      },
    },
  };
}

// state: { pr: {title, body, files[]}, ci: {failed_checks: [{name, log_excerpt}]}, review_comments: [...], rebase: {before_summary, after_summary} }
export function mergeGate(state) {
  return {
    state,
    questions: {
      ci_failure_unrelated_to_pr: noul(
        'Are the failing checks in `ci.failed_checks` unrelated to the changes in `pr` (flaky tests, infrastructure, timeouts, rate limits)?',
        'Failures are in areas the PR does not touch, or show flaky/infra signatures.',
        'Failures plausibly come from the PR changes.',
      ),
      open_review_comments_blocking: noul(
        'Do any of the unresolved `review_comments` request a change that must be made before merging?',
        'At least one comment asks for a real change, flags a bug, or explicitly blocks.',
        'Remaining comments are nits, questions already answered, praise, or optional suggestions.',
      ),
      behavior_changed_after_rebase: noul(
        'Comparing `rebase.before_summary` and `rebase.after_summary`, did rebasing or conflict resolution change what the PR does, beyond mechanically applying it on the new base?',
        'Conflict resolution altered logic, dropped or added behavior, or changed tests.',
        'Pure rebase: same behavior on a newer base.',
      ),
    },
  };
}

// state: { item, qa_step: {action, expected, actual}, merged_diff_summary }
export function qaFailure(state) {
  return {
    state,
    questions: {
      failure_is_regression_of_item: noul(
        'Is the failure in `qa_step` caused by the changes made for `item` (described in `merged_diff_summary`), rather than a pre-existing bug or an environment problem?',
        'The failing behavior is in the area the item changed and plausibly results from those changes.',
        'The failure is in unrelated functionality, existed before, or is caused by environment/data/setup.',
      ),
    },
  };
}

// state: { leaves: [{ref, title, body, acceptance_criteria, plan_summary, files[], risks[]}], teams, stacks }
export function planReview(state) {
  return {
    state,
    questions: {
      plan_needs_human_review: noul(
        'Before any code is written, does a person need to review the plans in `leaves`? Judge whether each `plan_summary` clearly does what its `title`, `body` and `acceptance_criteria` ask, with nothing ambiguous, risky or out of scope.',
        'At least one plan is ambiguous, misreads its item, leaves an acceptance criterion uncovered, changes more than the item asks, carries a serious risk, or depends on a product decision nobody has made.',
        'Every plan is a direct, bounded implementation of its item, and the listed risks are routine.',
      ),
    },
  };
}

// state: { item: {title, acceptance_criteria}, plan: {summary, files[]}, fix: {kind, asked: [...], summaries: [...], files_touched: [...]} }
export function fixScope(state) {
  return {
    state,
    questions: {
      fix_stays_within_item_scope: noul(
        'A pull request for `item` was already approved for merge. Then `fix` was applied to it. Does `fix` only do what `fix.asked` required, staying inside what `item` and `plan` describe?',
        'The fix addresses the listed problems and nothing else: no new behavior, no unrelated files, no removed tests.',
        'The fix adds or removes behavior beyond what was asked, touches unrelated areas, or weakens tests.',
      ),
    },
  };
}

// Normalize a Score answer (0..levels-1) to 0..1.
export const normScore = (ans, levels) => (ans?.score ?? 0) / (levels - 1);

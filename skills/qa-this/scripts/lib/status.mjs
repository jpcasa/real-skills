// Coverage, budgets and the status of an item. A status is computed from
// recorded check results and nothing else: no one reports it.

export const STATUSES = ['passed', 'failed', 'partial', 'blocked', 'not_run'];
export const RESULTS = ['pass', 'fail', 'skipped'];
export const BUDGET = { per_item: 30, per_run: 150, items: 10 };

// checks: only those that will run. A check Jev (once calibrated) judged not to
// exercise its criterion is `weak` and covers nothing.
export function coverage(criteria, checks) {
  // A runtime check is the model's own reading of a log: it can fail an item,
  // and it never stands in for a check the script recorded.
  const hit = new Set(checks.filter((c) => !c.weak && c.method !== 'runtime').map((c) => c.criterion));
  return {
    covered: criteria.filter((c) => hit.has(c.id)).map((c) => c.id),
    uncovered: criteria.filter((c) => !hit.has(c.id)).map((c) => c.id),
  };
}

// items: [{ checks }] -> the same items with checks cut to the budget, and how many were cut.
export function applyBudget(items) {
  let left = BUDGET.per_run;
  let cut = 0;
  const out = items.map((it) => {
    const keep = it.checks.slice(0, Math.min(BUDGET.per_item, left));
    left -= keep.length;
    cut += it.checks.length - keep.length;
    return { ...it, checks: keep };
  });
  return { items: out, cut };
}

// item: { criteria, checks: [{criterion, result, weak?, environmental?}], blocked?, dropped? }
export function itemStatus(item) {
  const criteria = item.criteria || [];
  const checks = item.checks || [];
  if (item.dropped || !criteria.length) return 'not_run';
  const ran = checks.filter((c) => c.result === 'pass' || c.result === 'fail');
  if (item.blocked && !ran.length) return 'blocked';
  const failed = checks.filter((c) => c.result === 'fail');
  // A failure Jev (once calibrated) reads as environment trouble is not a
  // product failure, and it is never a pass either.
  if (failed.some((c) => !c.environmental)) return 'failed';
  if (failed.length) return 'blocked';
  if (coverage(criteria, checks).uncovered.length) return 'partial';
  if (item.blocked || checks.some((c) => c.result !== 'pass')) return 'partial';
  return 'passed';
}

export const tally = (checks) => ({
  total: checks.length,
  passed: checks.filter((c) => c.result === 'pass').length,
  failed: checks.filter((c) => c.result === 'fail').length,
  skipped: checks.filter((c) => c.result !== 'pass' && c.result !== 'fail').length,
});

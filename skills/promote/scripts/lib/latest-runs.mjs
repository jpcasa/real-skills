// A check that ran more than once (a rerun, or a run cancelled by workflow
// concurrency and replaced) is listed once per run. It is judged by its latest
// run only: a cancelled run that a later one replaced is not a failure, and a
// pass that a later run failed is not a pass.
//
// Runs are the same check when workflow and check name match. A run with no
// timestamp is never dropped: nothing says a later one replaced it. Rows are
// read in the shape of `gh pr view --json statusCheckRollup` (startedAt) or of
// the REST check-runs API (started_at).

const timeOf = (c) => {
  const t = Date.parse(c.startedAt || c.started_at || c.completedAt || c.completed_at || '');
  return Number.isNaN(t) ? null : t;
};
const keyOf = (c) => `${c.workflowName || ''}\u0000${c.name || c.context || ''}`;

export function latestRuns(rows = []) {
  const newest = new Map();
  for (const c of rows) {
    const t = timeOf(c);
    if (t !== null && t > (newest.get(keyOf(c)) ?? -Infinity)) newest.set(keyOf(c), t);
  }
  return rows.filter((c) => {
    const t = timeOf(c);
    return t === null || t === newest.get(keyOf(c));
  });
}

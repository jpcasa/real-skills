// The run as the plan-progress mod's Plan pane wants it: one step per leaf,
// one task per stage. Shaped as the arguments of mcp__plan-progress__plan.

const BUILD = new Set(['build', 'replan']);
const REVIEW = new Set(['review', 'decide']);
const MERGE_ACTIVE = new Set(['queued', 'fixing', 'needs_reapproval']);

const task = (text, status) => ({ text, status });

function leafStep(run, item, ls) {
  const ref = `${item.ref} ${item.title}`.slice(0, 72);
  if (item.excluded) return { text: ref, status: 'blocked', note: `Excluded: ${item.excluded}`, tasks: [] };
  const notStarted = item.outcome?.startsWith('not_started');

  const planned = Boolean(item.plan);
  const stage = ls?.stage;
  const built = Boolean(stage) && !BUILD.has(stage);
  const reviewed = built && !REVIEW.has(stage);
  const entry = (run.merge_plan || []).find((e) => e.leaf === item.id);
  const merged = entry?.state === 'merged';

  const tasks = [
    task('Plan', planned ? 'done' : run.phase === 'plan' ? 'active' : 'pending'),
    task('Build', built ? 'done' : stage ? 'active' : 'pending'),
    task('Review', reviewed ? 'done' : REVIEW.has(stage) ? 'active' : 'pending'),
    task('PR', item.pr ? 'done' : reviewed ? 'active' : 'pending'),
    task('Merge', merged ? 'done' : entry && !MERGE_ACTIVE.has(entry.state) ? 'blocked' : entry ? 'active' : 'pending'),
  ];
  const q = run.qa?.enabled && merged ? run.qa.items?.[item.id] : undefined;
  if (run.qa?.enabled && merged) tasks.push(task('QA', q?.closed ? 'done' : 'active'));

  const notes = [];
  if (notStarted) notes.push(`Not started: ${item.outcome.split(': ')[1] || 'skipped'}`);
  if (ls?.loops?.length > 1 && !reviewed) notes.push(`Loop ${ls.loops.length}`);
  if (item.outcome === 'draft_flagged') notes.push('Draft PR: agent tests failed');
  if (entry && !merged && !MERGE_ACTIVE.has(entry.state)) notes.push(`Not merged: ${entry.state}`);
  if (q?.bugs?.length) notes.push(`QA filed ${q.bugs.length} bug(s)`);

  const status = notStarted || tasks.some((t) => t.status === 'blocked')
    ? 'blocked'
    : tasks.every((t) => t.status === 'done')
      ? 'done'
      : tasks.some((t) => t.status !== 'pending') ? 'active' : 'pending';
  return { text: ref, status, ...(notes.length ? { note: notes.join(' · ') } : {}), tasks };
}

// leafStates: { [leafId]: team.leaf_state[leafId] } across every team.
export function planPane(run, leafStates = {}) {
  return {
    title: `/do-shit ${run.run_id}`,
    note: `Phase: ${run.phase}${run.dry_run ? ' (dry run)' : ''}`,
    steps: run.items.filter((i) => i.leaf).map((i) => leafStep(run, i, leafStates[i.id])),
  };
}

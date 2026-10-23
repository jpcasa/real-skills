// The run as the plan-progress mod's Plan pane wants it: one step per leaf,
// named after its team, one task per stage with the roles working it.
// Shaped as the arguments of mcp__plan-progress__plan.
import { buildSequence, reviewSet } from './policy.mjs';

const BUILD = new Set(['build', 'replan']);
const REVIEW = new Set(['review', 'decide']);
const MERGE_ACTIVE = new Set(['queued', 'fixing', 'needs_reapproval']);

const task = (text, status) => ({ text, status });

// "Review: tester (running), auditor ✓"
function staffed(stage, roles, running, reported) {
  if (!roles.length) return stage;
  return `${stage}: ${roles.map((r) => (running.has(r) ? `${r} (running)` : reported.has(r) ? `${r} ✓` : r)).join(', ')}`;
}

function leafStep(run, item, ls, team) {
  const ref = `${team ? `${team.name} · ` : ''}${item.ref} ${item.title}`.slice(0, 72);
  if (item.excluded) return { text: ref, status: 'blocked', note: `Excluded: ${item.excluded}`, tasks: [] };
  const notStarted = item.outcome?.startsWith('not_started');

  const loop = ls?.loops?.[ls.loops.length - 1];
  const roles = loop?.roles || (item.roles || []).filter((r) => r !== 'investigator');
  const running = new Set(Object.values(run.pending || {}).filter((p) => p.role && p.leaf === item.id).map((p) => p.role));
  const reported = new Set(Object.keys(loop?.reports || {}));

  const planned = Boolean(item.plan);
  const stage = ls?.stage;
  const built = Boolean(stage) && !BUILD.has(stage);
  const reviewed = built && !REVIEW.has(stage);
  const entry = (run.merge_plan || []).find((e) => e.leaf === item.id);
  const merged = entry?.state === 'merged';

  const tasks = [
    task(staffed('Plan', ['investigator'], running, planned ? new Set(['investigator']) : new Set()), planned ? 'done' : run.phase === 'plan' ? 'active' : 'pending'),
    task(staffed('Build', buildSequence(roles), running, reported), built ? 'done' : stage ? 'active' : 'pending'),
    task(staffed('Review', reviewSet(roles), running, reported), reviewed ? 'done' : REVIEW.has(stage) ? 'active' : 'pending'),
    task('PR', item.pr ? 'done' : reviewed ? 'active' : 'pending'),
    task('Merge', merged ? 'done' : entry && !MERGE_ACTIVE.has(entry.state) ? 'blocked' : entry ? 'active' : 'pending'),
  ];
  const q = run.qa?.enabled && merged ? run.qa.items?.[item.id] : undefined;
  if (run.qa?.enabled && merged) tasks.push(task('QA', q?.closed ? 'done' : 'active'));

  const notes = [];
  if (team) notes.push(`Team ${team.name}`);
  if (notStarted) notes.push(`Not started: ${item.outcome.split(': ')[1] || 'skipped'}`);
  if (ls?.loops?.length > 1 && !reviewed) notes.push(`loop ${ls.loops.length}`);
  if (run.plan?.stacks?.[item.id]) notes.push(`stacked on ${run.items.find((i) => i.id === run.plan.stacks[item.id])?.ref}`);
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

// teams: the run's team files (S.loadTeams).
export function planPane(run, teams = []) {
  // Merge-phase fix teams reuse a leaf's id; the build team's state is the leaf's.
  const leafStates = Object.assign({}, ...teams.map((t) => Object.fromEntries(Object.entries(t.leaf_state).filter(([, ls]) => ls.kind !== 'merge_fix'))));
  const teamOf = (id) => run.plan?.teams?.find((t) => t.leaves.includes(id));
  const working = teams.filter((t) => t.name && Object.values(t.leaf_state).some((ls) => ls.stage !== 'done')).length;
  const agents = Object.keys(run.pending || {}).filter((k) => k.startsWith('spawn:')).length;
  const note = [`Phase: ${run.phase}${run.dry_run ? ' (dry run)' : ''}`];
  if (working) note.push(`${working} team${working === 1 ? '' : 's'} working`);
  if (agents) note.push(`${agents} agent${agents === 1 ? '' : 's'} running`);
  return {
    title: `/do-shit ${run.run_id}`,
    note: note.join(' · '),
    steps: run.items.filter((i) => i.leaf).map((i) => leafStep(run, i, leafStates[i.id], teamOf(i.id))),
  };
}

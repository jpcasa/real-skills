// The runbook for one target: what has to happen before, in what order, what
// to check after, and what can be rolled back. Built from the rule table, the
// config and the agent's checked steps. Full sentences: a teammate reads it.

import { RULES } from './rules.mjs';
import { code } from './post.mjs';

export const MAX_LINES = 20;
export const PHASES = ['before', 'order', 'after', 'rollback'];
const LABEL = { before: 'Before', order: 'Order', after: 'After', rollback: 'Rollback' };
// File, table and resource names come from the change: every one goes through code().
const list = (xs, n) => `${xs.slice(0, n).map(code).join(', ')}${xs.length > n ? ` and ${xs.length - n} more` : ''}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const by = (who) => (who ? ` (${[].concat(who).slice(0, 2).map(code).join(', ')})` : '');
const at = (f) => (f.file ? code(`${f.file}${f.line ? `:${f.line}` : ''}`) : 'the plan');

// target: { env, buckets, migration_entries: [{applied, applied_by}], infra_entries: [{applied_by}], live }
// -> { steps: [{phase, text}], lines: [string], dropped }
export function buildRunbook(target, findings, { manual = false } = {}) {
  const where = target.env ? code(target.env) : 'the target';
  const steps = [];
  const add = (phase, text) => {
    if (text && !steps.some((s) => s.phase === phase && s.text === text)) steps.push({ phase, text });
  };
  // Journals, snapshots and lock files sit in the same folder and are not migrations.
  const files = target.new_migrations || target.buckets?.migration || [];
  const migrations = files.length;
  const irreversible = findings.filter((f) => RULES[f.rule]?.reversible === false);

  // ---- before
  const vars = [...new Set(findings.filter((f) => f.rule === 'env_var_added').map((f) => f.name))];
  if (vars.length) add('before', `Set ${list(vars, 6)} on ${where}.`);
  for (const f of findings.filter((x) => x.rule === 'edited_existing_migration')) add('before', `Do not ship ${code(f.file)} as changed: put the change in a new migration.`);
  const backedUp = new Set();
  for (const f of irreversible) {
    if (f.bucket === 'migration') {
      const what = f.table ? `table ${code(f.table)}` : 'the data it touches';
      if (backedUp.has(what)) continue;
      backedUp.add(what);
      add('before', `Back up ${what} before ${at(f)} runs: a down-migration cannot bring it back.`);
    } else if (f.resource) add('before', `Take a snapshot or export of ${code(`${f.resource.type} ${f.resource.name || ''}`.trim())} before the infrastructure change.`);
  }
  if (manual) add('before', 'Jev expects a step by hand outside the normal deploy: confirm with the author what it is.');

  // ---- order
  if (migrations) {
    const entries = target.migration_entries?.length ? target.migration_entries : [{}];
    for (const e of entries) {
      if (e.applied === 'before_deploy') add('order', `Migrations run before the new code goes live${by(e.applied_by)}. Old code runs against the new schema until the deploy finishes.`);
      else if (e.applied === 'after_deploy') add('order', `The new code goes live before the migrations run${by(e.applied_by)}. It must work on the old schema until they finish.`);
      else if (e.applied === 'manual') add('order', 'A person runs the migrations. Decide whether that happens before or after the code deploy, and who does it.');
      else add('order', 'When migrations run relative to the code deploy is not configured: confirm it before pushing.');
    }
    const pending = target.live?.results?.applied?.ok ? target.live.results.applied.pending.length : null;
    add('order', pending === null ? `This change carries ${plural(migrations, 'migration file')}.` : `${plural(pending, 'migration')} not yet applied on ${where} will run.`);
  }
  if ((target.buckets?.infra || []).length) {
    const who = (target.infra_entries || []).flatMap((e) => [].concat(e.applied_by || []));
    add('order', who.length ? `Infrastructure is applied by ${who.slice(0, 2).map(code).join(', ')}.` : 'How the infrastructure change is applied is not configured: confirm who runs it and when.');
  }

  // ---- after
  if (migrations) add('after', `Confirm the new migrations are recorded as applied on ${where}.`);
  if (findings.some((f) => f.rule === 'index_concurrent')) add('after', 'Check that each concurrently built index finished valid.');
  if (findings.some((f) => f.rule === 'pipeline_changed')) add('after', 'The deploy pipeline itself changed: watch this run end to end.');

  // ---- rollback
  const lost = [...new Set(irreversible.filter((f) => f.bucket === 'migration').map((f) => f.file))];
  for (const file of lost) add('rollback', `${code(file)} is not reversible without the backup.`);
  const rest = files.filter((f) => /\.sql$/i.test(f) && !lost.includes(f)).length;
  if (rest) add('rollback', `${plural(rest, 'other migration file')} can be undone by a down-migration or a follow-up.`);
  for (const f of irreversible.filter((x) => x.resource)) add('rollback', `${code(`${f.resource.type} ${f.resource.name || ''}`.trim())} comes back only from its snapshot.`);

  // ---- the agent's steps, each already tied to a checked citation
  for (const f of findings) if (f.source === 'agent' && f.step && PHASES.includes(f.step.phase)) add(f.step.phase, f.step.text);

  const ordered = PHASES.flatMap((p) => steps.filter((s) => s.phase === p));
  let dropped = 0;
  // Over the cap: make room for the line that says how many were cut.
  while (ordered.length > (dropped ? MAX_LINES - 1 : MAX_LINES)) {
    // Cut from the longest phase, last step first.
    const sizes = PHASES.map((p) => ordered.filter((s) => s.phase === p).length);
    const phase = PHASES[sizes.indexOf(Math.max(...sizes))];
    ordered.splice(ordered.map((s) => s.phase).lastIndexOf(phase), 1);
    dropped += 1;
  }
  const lines = ordered.map((s) => `${LABEL[s.phase]}: ${s.text}`);
  if (dropped) lines.push(`…and ${plural(dropped, 'more step')}.`);
  return { steps: ordered, lines, dropped };
}

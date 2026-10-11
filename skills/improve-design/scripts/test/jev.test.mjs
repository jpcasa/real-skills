// Jev in /improve-design: logged and ignored until a question is calibrated;
// once it is, it can cut, reclassify, swap and drop, and it can add exactly one
// thing: a direction change the critic already proposed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'improve-design-jev-')));
process.env.IMPROVE_DESIGN_STATE_DIR = join(tmp, 'state');
process.env.IMPROVE_DESIGN_GH_STUB = join(tmp, 'gh.json');
process.env.REAL_SKILLS_CALIBRATION_DIR = join(tmp, 'calibration');
delete process.env.REAL_SKILLS_CALIBRATION;
writeFileSync(process.env.IMPROVE_DESIGN_GH_STUB, JSON.stringify({ prs: { 5: { number: 5, state: 'MERGED', mergedAt: 'x', url: 'https://github.com/acme/app/pull/5', headRefName: 'x' } }, create: { url: 'https://github.com/acme/app/pull/5' } }));

const impeccable = join(tmp, 'impeccable');
mkdirSync(join(impeccable, 'scripts'), { recursive: true });
writeFileSync(join(impeccable, 'SKILL.md'), 'version: 9.9.9\n');
writeFileSync(join(impeccable, 'scripts/detect.mjs'), 'console.log("[]");\n');
process.env.IMPROVE_DESIGN_IMPECCABLE = impeccable;
writeFileSync(join(tmp, 'shot.mjs'), "import { writeFileSync } from 'node:fs';\nconst [url, out, width] = process.argv.slice(2);\nwriteFileSync(out, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(width + ':' + (await (await fetch(url)).text()))]));\n");
process.env.IMPROVE_DESIGN_CAPTURE = `node ${join(tmp, 'shot.mjs')} {url} {out} {width}`;

const I = await import('../improve.mjs');
const S = await import('../lib/state.mjs');
const Q = await import('../lib/questions.mjs');
const C = await import('../lib/calibration.mjs');
const { HEURISTICS, AUDIT } = await import('../lib/verdict.mjs');

const repo = join(tmp, 'app');
const bare = join(tmp, 'app.git');
const sh = (args, cwd = repo) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
mkdirSync(join(repo, 'src'), { recursive: true });
mkdirSync(join(repo, '.claude'), { recursive: true });
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
sh(['config', 'user.email', 't@example.com']);
sh(['config', 'user.name', 't']);
sh(['remote', 'add', 'origin', bare]);
writeFileSync(join(repo, 'server.mjs'), "import { createServer } from 'node:http';\nimport { readFileSync } from 'node:fs';\ncreateServer((q, r) => r.end(readFileSync(new URL('./src/page.html', import.meta.url)))).listen(Number(process.argv[2]), '127.0.0.1');\n");
writeFileSync(join(repo, 'src/page.html'), '<h1>Settings</h1>\n<button>Save</button>\n');
writeFileSync(join(repo, '.claude/improve-design.json'), JSON.stringify({ dev: { command: 'node server.mjs {port}', timeout_s: 20 }, ui_paths: ['src/**/*.html'] }));
sh(['add', '-A']);
sh(['commit', '-q', '-m', 'init']);
sh(['push', '-q', '-u', 'origin', 'main']);

const opened = [];
after(async () => {
  for (const id of opened) await I.stop(id).catch(() => {});
});
const setEnv = (mode, calibrated = '') => {
  process.env.IMPROVE_DESIGN_JEV = mode;
  process.env.IMPROVE_DESIGN_TEST_CALIBRATED = calibrated;
};
const ALL = [...Q.UNCALIBRATED].join(',');
// answers: question id, or its prefix before "__", or prefix + "__" + n -> probability
const stub = (answers, seen = []) => async ({ state, questions }) => {
  seen.push({ state, questions });
  return { degraded: false, answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul: answers[id] ?? answers[id.split('__')[0]] ?? 0.5 }])) };
};
const issue = (id, over = {}) => ({ id, severity: 'P2', element: `el ${id}`, problem: `problem ${id}`, fix: `fix ${id}`, command: 'polish', source: 'critique', files: ['src/page.html'], visual: true, ...over });
const critique = (issues) => JSON.stringify({ heuristics: Object.fromEntries(HEURISTICS.map((h) => [h.id, 3])), audit: Object.fromEntries(AUDIT.map((d) => [d, 3])), issues });
const cases = () => C.readJsonl(join(S.stateRoot(), 'jev.jsonl'));

async function planned(issues, ask, input = {}) {
  const r = I.start({ repo, target: '/settings', session: { browser: false }, ...input });
  opened.push(r.run_id);
  I.prepare(r.run_id);
  await I.serve(r.run_id);
  I.detect({ run: r.run_id, files: ['src/page.html'] });
  I.shoot({ run: r.run_id, at: 'baseline' });
  I.baselineRecord(r.run_id, critique(issues));
  return { id: r.run_id, plan: await I.plan(r.run_id, { ask }) };
}
async function compared(id, moveId, word, ask, prefer = 'after') {
  I.moveStart({ run: id, move: moveId });
  const run = S.loadRun(id);
  const p = join(run.worktree, 'src/page.html');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/<button>.*<\/button>/, `<button>${word}</button>`));
  sh(['add', '-A'], run.worktree);
  sh(['-c', 'user.email=d@example.com', '-c', 'user.name=d', 'commit', '-q', '-m', moveId], run.worktree);
  I.moveCheck({ run: id, move: moveId }, '{}');
  I.shoot({ run: id, at: moveId });
  I.comparePlan({ run: id, move: moveId });
  const key = S.loadRun(id).moves.find((m) => m.id === moveId).compare.key;
  return I.compareRecord({ run: id, move: moveId }, JSON.stringify({ pairs: Object.entries(key).map(([pair, k]) => ({ pair, prefers: k.X === prefer ? 'X' : 'Y', [k.X === 'after' ? 'x' : 'y']: 'the button says more', [k.X === 'after' ? 'y' : 'x']: 'the button says Save' })) }), { ask });
}

test('six questions, all uncalibrated, each with a threshold and a direction', () => {
  assert.equal(Q.UNCALIBRATED.size, 6);
  for (const q of Q.UNCALIBRATED) {
    assert.ok(Q.THRESHOLDS[q] > 0 && Q.THRESHOLDS[q] < 1, q);
    assert.ok(['gte', 'lt'].includes(Q.META[q].acts_when), q);
    assert.equal(Q.calibrated(q), false);
  }
  assert.deepEqual([...Q.PLAN, ...Q.COMPARE].sort(), [...Q.UNCALIBRATED].sort());
  // The one answer that adds something is checked for the error of adding wrongly.
  assert.deepEqual(Q.META.direction_change_warranted, { acts_when: 'gte', unsafe: 'fp' });
});

test('uncalibrated, in shadow or live: logged, and the plan is what it would have been without Jev', async () => {
  const issues = [issue('a', { alt: 'layout' }), issue('b', { command: 'bolder' })];
  setEnv('off');
  const without = (await planned(issues, stub({}))).plan.moves;
  const extreme = { worth: 0.01, identity: 0.99, warranted: 0.99, alt: 0.99 };
  for (const mode of ['shadow', 'live']) {
    setEnv(mode);
    const before = cases().length;
    const seen = [];
    const { plan } = await planned(issues, stub(extreme, seen));
    assert.deepEqual(plan.moves, without, mode);
    assert.equal(seen.length, 1, 'one request for the whole plan');
    const logged = cases().slice(before);
    assert.deepEqual(logged.map((c) => c.question).sort(), ['alternative_fits_better', 'changes_visual_identity', 'changes_visual_identity', 'direction_change_warranted', 'direction_change_warranted', 'move_worth_doing', 'move_worth_doing']);
    assert.ok(logged.every((c) => c.type === 'case' && c.skill === 'improve-design' && c.acted === false && typeof c.threshold === 'number'));
  }
});

test('Jev unreachable: the plan is made without it', async () => {
  setEnv('live', ALL);
  const { plan } = await planned([issue('a')], async () => ({ degraded: true, error: 'timeout', answers: {} }));
  assert.deepEqual(plan.moves.map((m) => m.selected), [true]);
  const thrown = await planned([issue('a')], async () => {
    throw new Error('boom');
  });
  assert.deepEqual(thrown.plan.moves.map((m) => m.selected), [true]);
});

test('calibrated and live: cut, reclassify, swap, and let a proposed direction change through', async () => {
  setEnv('live', ALL);
  const { plan, id } = await planned([
    issue('a'), // cut
    issue('b'), // called a direction change
    issue('c', { alt: 'layout' }), // swapped
    issue('d', { command: 'bolder' }), // warranted
    issue('e', { command: 'colorize' }), // not warranted
  ], stub({ worth: 0.9, identity: 0.1, warranted: 0.1, alt: 0.1, worth__0: 0.1, identity__1: 0.9, alt__2: 0.9, warranted__3: 0.95 }), { auto: true });
  const by = Object.fromEntries(S.loadRun(id).moves.map((m) => [m.issues[0], m]));
  assert.deepEqual([by.a.selected, by.a.cut_by], [false, 'Jev']);
  assert.deepEqual([by.b.kind, by.b.selected, by.b.reclassified_by], ['shift', false, 'Jev']);
  assert.match(by.b.skipped, /direction/);
  assert.deepEqual([by.c.command, by.c.alt, by.c.swapped_by, by.c.selected], ['layout', 'polish', 'Jev', true]);
  assert.deepEqual([by.d.selected, by.d.selected_by, by.d.skipped], [true, 'Jev', undefined]);
  assert.deepEqual([by.e.selected, Boolean(by.e.skipped)], [false, true]);
  // Refine moves still run first, and the text says who decided what.
  assert.deepEqual(plan.moves.map((m) => m.kind), ['refine', 'refine', 'shift', 'shift', 'shift']);
  assert.match(plan.checkpoint.join('\n'), /cut by Jev/);
  assert.match(plan.checkpoint.join('\n'), /command chosen by Jev/);
});

test('calibrated but not live, or only some questions calibrated: only those act', async () => {
  setEnv('shadow', ALL);
  const shadow = await planned([issue('a')], stub({ worth: 0.01 }));
  assert.deepEqual(shadow.plan.moves.map((m) => m.selected), [true]);
  setEnv('live', 'move_worth_doing');
  const one = await planned([issue('a'), issue('b')], stub({ worth__0: 0.01, identity: 0.99 }));
  assert.deepEqual(S.loadRun(one.id).moves.map((m) => [m.kind, m.selected]), [['refine', false], ['refine', true]]);
  // --direction is the user's own yes: nothing Jev says removes it.
  setEnv('live', ALL);
  const forced = await planned([issue('a', { command: 'bolder' })], stub({ worth: 0.01, warranted: 0.01 }), { direction: 'bolder', auto: true });
  assert.deepEqual(forced.plan.moves.map((m) => [m.forced, m.selected]), [[true, true]]);
});

test('what is sent: lines the critic wrote, scrubbed; no source, no diff, no query string', async () => {
  setEnv('shadow');
  const seen = [];
  const { id } = await planned([issue('a', { problem: 'Mail ada@lovelace.example sees https://app.example.com/reset?token=abc123 in the banner', element: 'Banner' })], stub({}, seen));
  const sent = JSON.stringify(seen[0]);
  assert.ok(!/ada@lovelace|token=abc123|<button>|<h1>/.test(sent), sent);
  assert.deepEqual(Object.keys(seen[0].state).sort(), ['moves', 'screen']);
  assert.deepEqual(Object.keys(seen[0].state.moves[0]).sort(), ['alternative', 'command', 'element', 'files', 'found_by', 'intent', 'problem', 'severity']);
  assert.equal(seen[0].state.screen.route, '/settings');
  I.approve({ run: id, moves: ['m1'] });
  const later = [];
  await compared(id, 'm1', 'Save changes', stub({}, later));
  assert.deepEqual(Object.keys(later[0].state).sort(), ['detector', 'move', 'views']);
  assert.deepEqual(later[0].state.views[0], { viewport: later[0].state.views[0].viewport, before: 'the button says Save', after: 'the button says more' });
  assert.ok(!/Save changes|\.png|worktrees/.test(JSON.stringify(later[0])));
  // The log line a person labels from is redacted too.
  assert.ok(cases().filter((c) => c.type === 'case').every((c) => !/ada@lovelace|token=abc123/.test(c.show || '')));
});

test('after the comparison: calibrated, a low is_improvement or a high harms_another_state drops a preferred move', async () => {
  setEnv('live', ALL);
  const a = await planned([issue('a'), issue('b'), issue('c')], stub({ worth: 0.9, identity: 0.1 }));
  I.approve({ run: a.id, moves: ['m1', 'm2', 'm3'] });
  const head = () => sh(['rev-parse', 'HEAD'], S.loadRun(a.id).worktree);
  const start = head();
  const low = await compared(a.id, 'm1', 'Sv', stub({ is_improvement: 0.1, harms_another_state: 0.1 }));
  assert.deepEqual([low.kept, low.reasons], [false, ['jev: is_improvement']]);
  assert.equal(head(), start);
  const harm = await compared(a.id, 'm2', 'Save all', stub({ is_improvement: 0.9, harms_another_state: 0.9 }));
  assert.deepEqual(harm.reasons, ['jev: harms_another_state']);
  // It can drop. It cannot keep: the critic preferred the old screen, and a glowing number changes nothing.
  const glowing = await compared(a.id, 'm3', 'Save now', stub({ is_improvement: 0.99, harms_another_state: 0.01 }), 'before');
  assert.equal(glowing.kept, false);
  assert.match(glowing.reasons[0], /^before_preferred/);
  assert.equal(I.final(a.id).verdict, 'no_change');

  // The same numbers, uncalibrated: logged, and the move stays.
  setEnv('live');
  const b = await planned([issue('a')], stub({}));
  I.approve({ run: b.id, moves: ['m1'] });
  const kept = await compared(b.id, 'm1', 'Save changes', stub({ is_improvement: 0.01, harms_another_state: 0.99 }));
  assert.equal(kept.kept, true);
  assert.deepEqual(S.loadRun(b.id).moves[0].jev.is_improvement, 0.01);
});

test('labels: the checkpoint answers, a merged pull request, and a move called wrong', async () => {
  setEnv('shadow');
  const { id } = await planned([issue('a', { alt: 'layout' }), issue('b'), issue('c', { command: 'bolder' })], stub({ worth: 0.6, warranted: 0.7, alt: 0.2, is_improvement: 0.8 }));
  const before = cases().length;
  I.approve({ run: id, moves: ['m1', 'm3'], commands: { m1: 'layout' } });
  const labels = cases().slice(before).filter((r) => r.type === 'label');
  assert.deepEqual(labels.map((l) => [l.question, l.label, l.source]).sort(), [
    ['alternative_fits_better', true, 'checkpoint'],
    ['direction_change_warranted', true, 'checkpoint'],
    ['move_worth_doing', false, 'checkpoint'],
    ['move_worth_doing', true, 'checkpoint'],
  ]);
  const logged = new Set(cases().filter((r) => r.type === 'case').map((c) => c.case));
  assert.ok(labels.every((l) => logged.has(l.case)), 'every label points at a logged case');

  await compared(id, 'm1', 'Save changes', stub({ is_improvement: 0.8 }));
  const run = S.loadRun(id);
  // The direction change was ticked and never run: leave it out so the run can end.
  for (const m of run.moves) if (!m.decision) m.selected = false;
  S.saveRun(run);
  I.final(id, critique([]));
  I.ship(id);
  const n = cases().length;
  assert.equal(I.outcome({ run: id }).recorded, 1);
  assert.deepEqual(cases().slice(n).map((l) => [l.question, l.label, l.source]), [['is_improvement', true, 'merged']]);
  I.outcome({ run: id, move: 'm1', result: 'wrong' });
  assert.deepEqual(cases().at(-1).label, false);
});

test('a calibrated question is switched off by one unsafe answer', async () => {
  setEnv('live');
  C.setEntry('improve-design', 'direction_change_warranted', { threshold: 0.8, n: 30, applied: 'test' });
  assert.equal(Q.calibrated('direction_change_warranted'), true);
  const { id } = await planned([issue('a', { command: 'bolder' })], stub({ warranted: 0.95 }));
  const m = S.loadRun(id).moves[0];
  // One decision in ten is held back as a spot check; either way the user is asked here, and says no.
  assert.ok(m.selected === true || cases().at(-1).spot === true);
  I.approve({ run: id, moves: [] });
  assert.equal(Q.calibrated('direction_change_warranted'), false, 'saying a direction change was needed when it was not is the unsafe error');
  assert.ok(existsSync(join(process.env.REAL_SKILLS_CALIBRATION_DIR, 'revoked.jsonl')));
});

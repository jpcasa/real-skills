// End to end on a temp repo: a real worktree, a real dev server and real git,
// with the detector, the camera, gh and the agents stood in for.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'improve-design-')));
process.env.IMPROVE_DESIGN_STATE_DIR = join(tmp, 'state');
process.env.IMPROVE_DESIGN_GH_STUB = join(tmp, 'gh.json');
process.env.REAL_SKILLS_CALIBRATION_DIR = join(tmp, 'calibration');
delete process.env.REAL_SKILLS_CALIBRATION;
delete process.env.IMPROVE_DESIGN_TEST_CALIBRATED;
process.env.IMPROVE_DESIGN_JEV = 'off';

// impeccable, as far as the harness needs it: a detector and a rubric file.
const impeccable = join(tmp, 'impeccable');
mkdirSync(join(impeccable, 'scripts'), { recursive: true });
mkdirSync(join(impeccable, 'reference'), { recursive: true });
writeFileSync(join(impeccable, 'SKILL.md'), '---\nname: impeccable\nversion: 9.9.9\n---\n');
writeFileSync(join(impeccable, 'reference/critique.md'), 'rubric\n');
// One finding per SLOP in a file, one advisory per ADVISORY. Exit 2 on findings.
writeFileSync(join(impeccable, 'scripts/detect.mjs'), `
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
const walk = (p) => statSync(p).isDirectory() ? readdirSync(p).flatMap((e) => walk(join(p, e))) : [p];
const out = [];
for (const arg of process.argv.slice(2).filter((a) => !a.startsWith('--'))) for (const file of walk(resolve(arg))) {
  readFileSync(file, 'utf8').split('\\n').forEach((line, n) => {
    if (line.includes('SLOP')) out.push({ antipattern: 'slop', name: 'Slop', severity: 'warning', file, line: n + 1 });
    if (line.includes('ADVISORY')) out.push({ antipattern: 'dash', name: 'Dash', severity: 'advisory', advisory: true, file, line: n + 1 });
  });
}
console.log(JSON.stringify(out));
process.exit(out.some((f) => !f.advisory) ? 2 : 0);
`);
process.env.IMPROVE_DESIGN_IMPECCABLE = impeccable;
// A camera: the "picture" is the PNG magic number, the width and the page.
writeFileSync(join(tmp, 'shot.mjs'), `
import { writeFileSync } from 'node:fs';
const [url, out, width] = process.argv.slice(2);
const body = await (await fetch(url)).text();
writeFileSync(out, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(width + ':' + body)]));
`);
process.env.IMPROVE_DESIGN_CAPTURE = `node ${join(tmp, 'shot.mjs')} {url} {out} {width}`;

const I = await import('../improve.mjs');
const S = await import('../lib/state.mjs');
const G = await import('../lib/git.mjs');
const { loadConfig, parseTarget } = await import('../lib/config.mjs');
const { copyFiles, copyRefusal, removeCopies, startedAt, stopServer, alive } = await import('../lib/dev.mjs');
const { HEURISTICS, AUDIT } = await import('../lib/verdict.mjs');

const TOKEN = `ghp_${'a'.repeat(36)}`;
const GATE = '! grep -q BREAKGATE src/page.html';
const CONFIG = { dev: { command: 'node server.mjs {port}', copy: ['.env.local', 'tracked.env', 'nope.env'], timeout_s: 20 }, gates: [GATE], ui_paths: ['src/**/*.html', 'src/**/*.css'] };
const opened = [];
after(async () => {
  for (const id of opened) await I.stop(id).catch(() => {});
});

function makeApp(name, config = CONFIG, extra = {}) {
  const repo = join(tmp, name);
  const bare = join(tmp, `${name}.git`);
  const sh = (args, cwd = repo) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  sh(['config', 'user.email', 't@example.com']);
  sh(['config', 'user.name', 't']);
  // A GitHub address that really goes to the bare repo next door.
  sh(['config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git']);
  sh(['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  writeFileSync(join(repo, 'server.mjs'), "import { createServer } from 'node:http';\nimport { readFileSync } from 'node:fs';\ncreateServer((q, r) => (q.url === '/private' ? r.writeHead(302, { location: '/login' }).end() : r.end(readFileSync(new URL('./src/page.html', import.meta.url))))).listen(Number(process.argv[2]), '127.0.0.1');\n");
  writeFileSync(join(repo, 'src/page.html'), '<h1>Settings</h1>\n<button>Save</button>\nSLOP\n');
  writeFileSync(join(repo, 'src/other.css'), 'a { color: red }\n');
  writeFileSync(join(repo, 'src/logic.js'), 'export const n = 1;\n');
  writeFileSync(join(repo, '.gitignore'), '.env.local\nnode_modules\n');
  writeFileSync(join(repo, '.env.local'), 'SECRET=1\n');
  writeFileSync(join(repo, 'tracked.env'), 'A=1\n');
  writeFileSync(join(repo, '.claude/improve-design.json'), JSON.stringify(config, null, 2));
  for (const [f, body] of Object.entries(extra)) writeFileSync(join(repo, f), body);
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', 'init']);
  sh(['push', '-q', '-u', 'origin', 'main']);
  return { repo, bare, sh };
}
const app = makeApp('app');
writeFileSync(process.env.IMPROVE_DESIGN_GH_STUB, JSON.stringify({
  prs: {
    7: { number: 7, state: 'OPEN', url: 'https://github.com/acme/app/pull/7', headRefName: 'feature', baseRefName: 'main' },
    8: { number: 8, state: 'CLOSED', url: 'u', headRefName: 'old' },
    9: { number: 9, state: 'OPEN', url: 'u', headRefName: 'theirs', isCrossRepository: true },
    41: { number: 41, state: 'MERGED', url: 'https://github.com/acme/app/pull/41', headRefName: 'x', mergedAt: '2026-10-09T00:00:00Z' },
  },
  create: { url: 'https://github.com/acme/app/pull/41' },
}));
const calls = () => (existsSync(`${process.env.IMPROVE_DESIGN_GH_STUB}.calls`) ? readFileSync(`${process.env.IMPROVE_DESIGN_GH_STUB}.calls`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

const issue = (id, over = {}) => ({ id, severity: 'P2', element: `el ${id}`, problem: `problem ${id}`, fix: `fix ${id}`, command: 'polish', source: 'critique', files: ['src/page.html'], visual: true, ...over });
const scores = (over = {}) => Object.fromEntries(HEURISTICS.map((h) => [h.id, over[h.id] ?? 3]));
const critique = (issues, over = {}) => JSON.stringify({ heuristics: scores(over), audit: Object.fromEntries(AUDIT.map((d) => [d, 3])), issues });
const wtGit = (run, args) => execFileSync('git', ['-C', run.worktree, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

// start → prepare → serve → detect → baseline pictures → baseline → plan (→ approve what is ticked)
async function open(issues, { input = {}, on = app, approve = true } = {}) {
  const started = I.start({ repo: on.repo, target: '/settings', session: { browser: false }, ...input });
  assert.ok(started.run_id, JSON.stringify(started));
  opened.push(started.run_id);
  I.prepare(started.run_id);
  const served = await I.serve(started.run_id);
  I.detect({ run: started.run_id, files: ['src/page.html'] });
  if (served.mode === 'rendered') I.shoot({ run: started.run_id, at: 'baseline' });
  I.baselineRecord(started.run_id, critique(issues));
  const planned = await I.plan(started.run_id);
  if (approve && !input.auto) I.approve({ run: started.run_id, moves: planned.moves.filter((m) => m.selected).map((m) => m.id) });
  return { id: started.run_id, started, served, planned };
}
const edit = (file, change) => (run) => {
  const p = join(run.worktree, file);
  writeFileSync(p, change(existsSync(p) ? readFileSync(p, 'utf8') : ''));
};
// One move the way the skill runs it. `design` stands in for the designer,
// `prefer` for the comparing critic: before | after | same, or an object to send as is.
async function move(id, moveId, design, { prefer = 'after', commit = true, broke = null, answer = null } = {}) {
  I.moveStart({ run: id, move: moveId });
  const run = S.loadRun(id);
  if (design) design(run);
  if (design && commit) {
    wtGit(run, ['add', '-A']);
    wtGit(run, ['-c', 'user.email=d@example.com', '-c', 'user.name=d', 'commit', '-q', '-m', `${moveId}: change`]);
  }
  const checked = I.moveCheck({ run: id, move: moveId }, '{"status": "done"}');
  if (checked.vetoed) return { checked, result: checked };
  if (checked.next === 'shoot') I.shoot({ run: id, at: moveId });
  const planned = I.comparePlan({ run: id, move: moveId });
  if (!planned.critic) return { checked, planned, result: planned };
  const key = S.loadRun(id).moves.find((m) => m.id === moveId).compare.key;
  const message = answer || { pairs: Object.entries(key).map(([pair, k]) => ({ pair, prefers: prefer === 'same' ? 'same' : k.X === prefer ? 'X' : 'Y', x: 'shows x', y: 'shows y', broke: broke ? { side: k.X === 'after' ? 'X' : 'Y', ...broke } : null })) };
  const result = await I.compareRecord({ run: id, move: moveId }, JSON.stringify(message));
  return { checked, planned, result };
}

// The rest of a move after the designer's commit: check, pictures, comparison preferring the new screen.
move.finish = async (id, moveId) => {
  const checked = I.moveCheck({ run: id, move: moveId }, '{}');
  if (checked.next === 'shoot') I.shoot({ run: id, at: moveId });
  const planned = I.comparePlan({ run: id, move: moveId });
  if (!planned.critic) return planned;
  const key = S.loadRun(id).moves.find((m) => m.id === moveId).compare.key;
  return I.compareRecord({ run: id, move: moveId }, JSON.stringify({ pairs: Object.entries(key).map(([pair, k]) => ({ pair, prefers: k.X === 'after' ? 'X' : 'Y', x: 'x', y: 'y' })) }));
};

// ---------------------------------------------------------------- task 2: start and stop
test('config: defaults, and production_hosts read from the other skills\' files', () => {
  const other = makeApp('conf', { dev: { command: 'x' } }, { '.claude/qa-this.json': JSON.stringify({ production_hosts: ['app.example.com'] }) });
  const { config, sources, missing } = loadConfig(other.repo);
  assert.deepEqual(config.production_hosts, ['app.example.com']);
  assert.equal(sources.production_hosts, '.claude/qa-this.json');
  assert.deepEqual(config.viewports, ['1440x900', '390x844']);
  assert.equal(config.max_moves, 6);
  assert.equal(config.pr.draft, 'auto');
  assert.deepEqual(missing, ['gates']);
  assert.match(parseTarget(config, { target: 'https://app.example.com/settings?token=abc' }).problem, /production host/);
  assert.match(parseTarget(config, { target: 'https://staging.example.org/settings' }).problem, /not this machine/);
  assert.deepEqual(parseTarget(config, { target: 'http://localhost:3000/settings?token=abc' }), { route: '/settings', file: null });
  assert.match(parseTarget(config, { target: 'src/page.html' }).problem, /--route/);
  assert.deepEqual(parseTarget(config, { target: 'src/page.html', route: '/settings' }), { route: '/settings', file: 'src/page.html' });
  assert.match(parseTarget(config, { target: '../x.tsx', route: '/a' }).problem, /inside the repo/);
});

test('start refuses before it creates anything', () => {
  const before = app.sh(['worktree', 'list']);
  assert.match(I.start({ repo: app.repo, target: 'https://example.com/x' }).problems[0], /not this machine/);
  assert.match(I.start({ repo: app.repo, target: '/settings', direction: 'critique' }).problems[0], /--direction/);
  assert.match(I.start({ repo: app.repo, target: 'src/missing.html', route: '/settings' }).problems[0], /not a file/);
  assert.match(I.start({ repo: app.repo, target: '/settings', pr: 8 }).problems[0], /closed/);
  assert.match(I.start({ repo: app.repo, target: '/settings', pr: 9 }).problems[0], /fork/);
  assert.match(I.start({ repo: app.repo, target: '/settings', pr: 99 }).problems[0], /no pull request/);
  const was = process.env.IMPROVE_DESIGN_IMPECCABLE;
  process.env.IMPROVE_DESIGN_IMPECCABLE = join(tmp, 'nowhere');
  assert.match(I.start({ repo: app.repo, target: '/settings' }).problems[0], /impeccable plugin is not installed/);
  process.env.IMPROVE_DESIGN_IMPECCABLE = was;
  assert.equal(app.sh(['worktree', 'list']), before);
});

test('start: its own worktree and branch from the base, env files copied only when git ignores them', async () => {
  const r = I.start({ repo: app.repo, target: '/settings', session: { browser: false } });
  opened.push(r.run_id);
  assert.match(r.worktree, /\/app\/\.claude\/worktrees\/id-\d{8}-\d{4}-[0-9a-f]{4}$/);
  assert.match(r.branch, /^improve-design\/settings-\d{8}-[0-9a-f]{4}$/);
  const run = S.loadRun(r.run_id);
  assert.equal(wtGit(run, ['rev-parse', '--abbrev-ref', 'HEAD']), r.branch);
  assert.equal(run.start_sha, app.sh(['rev-parse', 'origin/main']));
  assert.deepEqual(r.copied, ['.env.local']);
  assert.deepEqual(r.copy_refused.map((c) => c.path), ['tracked.env', 'nope.env']);
  assert.match(copyRefusal(app.repo, 'tracked.env'), /tracked/);
  assert.match(copyRefusal(app.repo, '../x'), /inside the repo/);
  assert.match(copyRefusal(app.repo, 'server.mjs'), /tracked/);
  assert.ok(existsSync(join(r.worktree, '.env.local')));
  assert.ok(G.isClean(r.worktree), 'a copied env file does not dirty the tree');

  const prepared = I.prepare(r.run_id);
  assert.deepEqual(prepared.gates.map((g) => [g.cmd, g.ok]), [[GATE, true]]);
  const served = await I.serve(r.run_id);
  assert.equal(served.mode, 'rendered');
  assert.equal(served.pictures_by, 'command');
  assert.match(await (await fetch(served.url)).text(), /Settings/);

  const stopped = await I.stop(r.run_id);
  assert.equal(stopped.server_stopped, true);
  assert.equal(stopped.worktree_removed, true, 'nothing kept: the worktree and branch go');
  assert.ok(!existsSync(r.worktree));
  assert.equal(app.sh(['branch', '--list', r.branch]), '');
  await assert.rejects(fetch(served.url));
});

test('--pr stacks on the pull request\'s branch', () => {
  app.sh(['branch', 'feature']);
  app.sh(['push', '-q', 'origin', 'feature']);
  const r = I.start({ repo: app.repo, target: '/settings', pr: 7, session: { browser: false } });
  opened.push(r.run_id);
  assert.equal(r.base, 'feature');
  assert.equal(r.stacked.number, 7);
});

test('code only: no dev command, a server that dies, or no way to take a picture', async () => {
  const bare = makeApp('nodev', { gates: [GATE] });
  const a = I.start({ repo: bare.repo, target: '/settings', session: { browser: false } });
  opened.push(a.run_id);
  I.prepare(a.run_id);
  assert.match((await I.serve(a.run_id)).why, /no dev\.command/);

  const dying = makeApp('dying', { dev: { command: 'node -e "process.exit(3)"', timeout_s: 10 } });
  const b = I.start({ repo: dying.repo, target: '/settings', session: { browser: false } });
  opened.push(b.run_id);
  I.prepare(b.run_id);
  const served = await I.serve(b.run_id);
  assert.equal(served.mode, 'code_only');
  assert.match(served.why, /exited/);
  assert.equal(I.shoot({ run: b.run_id, at: 'baseline' }).skipped.startsWith('the run is code_only'), true);

  const capture = process.env.IMPROVE_DESIGN_CAPTURE;
  delete process.env.IMPROVE_DESIGN_CAPTURE;
  process.env.IMPROVE_DESIGN_NO_BROWSER = '1';
  try {
    const c = I.start({ repo: app.repo, target: '/settings', session: { browser: false } });
    opened.push(c.run_id);
    I.prepare(c.run_id);
    assert.match((await I.serve(c.run_id)).why, /no way to take a picture/);
    // With a browser in the session an agent takes them, and the script checks what it is handed.
    const d = I.start({ repo: app.repo, target: '/settings', session: { browser: true } });
    opened.push(d.run_id);
    I.prepare(d.run_id);
    assert.equal((await I.serve(d.run_id)).pictures_by, 'agent');
    const want = I.shoot({ run: d.run_id, at: 'baseline' });
    assert.equal(want.by, 'agent');
    assert.equal(want.save_to.length, 2);
    writeFileSync(want.save_to[0].path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
    writeFileSync(want.save_to[1].path, 'not a picture');
    writeFileSync(join(tmp, 'elsewhere.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
    const rec = I.shotsRecord({ run: d.run_id, at: 'baseline', shots: [...want.save_to, { viewport: '1440x900', path: join(tmp, 'elsewhere.png') }, { viewport: '1x1', path: want.save_to[0].path }] });
    assert.deepEqual(rec.taken, ['1440x900']);
    assert.equal(rec.dropped.length, 3);
  } finally {
    process.env.IMPROVE_DESIGN_CAPTURE = capture;
    delete process.env.IMPROVE_DESIGN_NO_BROWSER;
  }
});

// ---------------------------------------------------------------- task 3: baseline, plan, checkpoint
test('detect, baseline and plan', async () => {
  const r = I.start({ repo: app.repo, target: '/settings', max_moves: 2, session: { browser: false } });
  opened.push(r.run_id);
  I.prepare(r.run_id);
  await I.serve(r.run_id);
  const run0 = S.loadRun(r.run_id);
  writeFileSync(join(run0.worktree, 'src/adv.html'), 'ADVISORY\n');
  const d = I.detect({ run: r.run_id, files: ['src/page.html', 'src/adv.html', 'src/none.html', '/etc/passwd'] });
  assert.deepEqual(d.files, ['src/page.html', 'src/adv.html']);
  assert.deepEqual(d.detector.findings.map((f) => [f.rule, f.file, f.line]), [['slop', 'src/page.html', 3]]);
  assert.equal(d.detector.advisory, 1);
  execFileSync('rm', [join(run0.worktree, 'src/adv.html')]);

  const short = JSON.parse(critique([]));
  delete short.heuristics.h4;
  assert.throws(() => I.baselineRecord(r.run_id, JSON.stringify(short)), /h4/);
  assert.throws(() => I.baselineRecord(r.run_id, 'I looked at it and it is fine.'), /no JSON/);
  const rec = I.baselineRecord(r.run_id, `Here it is:\n\`\`\`json\n${critique([
    issue('a', { severity: 'P1' }),
    issue('b', { command: 'bolder', severity: 'P0' }),
    issue('c', { files: ['/etc/passwd', '../x'] }),
    issue('d', { severity: 'P3' }),
    issue('e', { command: 'nonsense' }),
  ], { h7: 'n/a', h1: 1 })}\n\`\`\``);
  assert.deepEqual([rec.total, rec.max, rec.na], [25, 36, ['h7']]);
  assert.deepEqual(rec.refused.map((x) => x.issue), ['c']);

  const p = await I.plan(r.run_id);
  assert.deepEqual(p.moves.map((m) => [m.id, m.command, m.selected]), [['m1', 'polish', true], ['m2', 'bolder', false]]);
  assert.equal(p.cut, 1);
  assert.deepEqual(p.refused.map((x) => x.issue), ['c', 'e']);
  assert.equal(p.next, 'approve');
  const text = p.checkpoint.join('\n');
  assert.match(text, /25\/36/);
  assert.match(text, /Weakest: Visibility of system status 1\/4/);
  assert.match(text, /\[x\] m1 P1 polish · el a/);
  assert.match(text, /\[ \] m2 P0 bolder .*direction change/);
  assert.match(text, /Left out, over the limit of 2/);
  assert.match(text, /1 designer, up to 1 comparison, 1 re-score/);
  assert.throws(() => I.moveStart({ run: r.run_id, move: 'm1' }), /not been approved/);

  assert.throws(() => I.approve({ run: r.run_id, moves: ['m9'] }), /no move m9/);
  assert.throws(() => I.approve({ run: r.run_id, moves: ['m1'], commands: { m1: 'redesign' } }), /not one of/);
  const ok = I.approve({ run: r.run_id, moves: ['m1', 'm2'], commands: { m1: 'layout' }, screenshots: true });
  assert.deepEqual(ok.queue, ['m1', 'm2']);
  const run = S.loadRun(r.run_id);
  assert.deepEqual(run.moves.map((m) => [m.command, m.selected]), [['layout', true], ['bolder', true]]);
  assert.equal(run.moves[0].command_by, 'user');
  assert.equal(run.flags.screenshots, true);
});

test('--auto runs refine moves, skips a direction change, and needs no approval', async () => {
  const { id, planned } = await open([issue('a'), issue('b', { command: 'colorize' })], { input: { auto: true } });
  assert.deepEqual(planned.moves.map((m) => [m.command, m.selected, Boolean(m.skipped)]), [['polish', true, false], ['colorize', false, true]]);
  assert.equal(planned.ask, null);
  assert.equal(planned.next, 'move-start');
  assert.equal(I.moveStart({ run: id, move: 'm1' }).agent, 'real-skills:designer');
  // --direction is a yes, also under --auto.
  const forced = await open([issue('a')], { input: { auto: true, direction: 'bolder' } });
  assert.deepEqual(forced.planned.moves.map((m) => [m.command, m.selected]), [['polish', true], ['bolder', true]]);
});

// ---------------------------------------------------------------- task 4: the move loop
test('a move the comparison prefers is kept; the designer and critic prompts say what they must', async () => {
  const { id } = await open([issue('a'), issue('b')]);
  const brief = I.brief({ run: id, job: 'critique' });
  const critic = readFileSync(brief.prompt_file, 'utf8');
  assert.match(critic, /slop at src\/page\.html:3/);
  assert.match(critic, /baseline-1440x900\.png/);
  assert.equal(brief.pictures, 2);

  const started = I.moveStart({ run: id, move: 'm1' });
  const prompt = readFileSync(started.prompt_file, 'utf8');
  assert.match(prompt, /\/impeccable polish/);
  assert.match(prompt, /Never push/);
  assert.match(prompt, new RegExp(S.loadRun(id).worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.throws(() => I.moveStart({ run: id, move: 'm2' }), /m1 is next/);
  const run = S.loadRun(id);
  edit('src/page.html', (s) => s.replace('Save', 'Save changes'))(run);
  wtGit(run, ['add', '-A']);
  wtGit(run, ['-c', 'user.email=d@example.com', '-c', 'user.name=d', 'commit', '-q', '-m', 'm1']);
  const checked = I.moveCheck({ run: id, move: 'm1' }, 'done {"status":"done"}');
  assert.deepEqual([checked.committed, checked.files, checked.next], [true, 1, 'shoot']);
  assert.deepEqual(checked.gates, [{ cmd: GATE, ok: true }]);
  I.shoot({ run: id, at: 'm1' });
  const sheet = I.comparePlan({ run: id, move: 'm1' });
  assert.equal(sheet.pairs, 2);
  const text = readFileSync(sheet.prompt_file, 'utf8');
  // Nothing the critic is handed says which side is newer, or where the run lives.
  assert.ok(!text.includes(S.runDir(id)) && !/baseline|m1-|after|before/.test(text), text);
  assert.match(text, /p1-X\.png/);
  assert.match(text, /problem a/);
  const key = S.loadRun(id).moves[0].compare.key;
  const res = await I.compareRecord({ run: id, move: 'm1' }, JSON.stringify({ pairs: Object.entries(key).map(([pair, k]) => ({ pair, prefers: k.X === 'after' ? 'X' : 'Y', x: 'x', y: 'y' })) }));
  assert.deepEqual([res.kept, res.next, res.next_move], [true, 'move-start', 'm2']);
  const now = S.loadRun(id);
  assert.equal(now.state_at, 'm1');
  assert.equal(now.moves[0].compare.key, undefined, 'the key is gone once it has been used');
  assert.ok(!existsSync(sheet.prompt_file));
  assert.throws(() => I.comparePlan({ run: id, move: 'm1' }), /already decided/);

  // The re-scoring critic is told nothing about before.
  const rescore = readFileSync(I.brief({ run: id, job: 'rescore' }).prompt_file, 'utf8');
  assert.match(rescore, /m1-1440x900\.png/);
  assert.ok(!/baseline-|problem a|polish/.test(rescore), rescore);
});

test('vetoes: out of scope, a gate turned red, a new detector finding, no commit, leftovers', async () => {
  const { id } = await open(['a', 'b', 'c', 'd', 'e', 'f'].map((x) => issue(x)));
  const head = () => wtGit(S.loadRun(id), ['rev-parse', 'HEAD']);
  const start = head();

  const scope = await move(id, 'm1', edit('src/logic.js', () => 'export const n = 2;\n'));
  assert.equal(scope.result.vetoed, true);
  assert.match(scope.result.reasons[0], /^out_of_scope: src\/logic\.js/);
  assert.equal(head(), start, 'the commit is off the branch');
  assert.match(readFileSync(scope.result.patch, 'utf8'), /export const n = 2/);
  assert.throws(() => I.comparePlan({ run: id, move: 'm1' }), /already decided/);

  const gate = await move(id, 'm2', edit('src/page.html', (s) => `${s}BREAKGATE\n`));
  assert.match(gate.result.reasons[0], /^gate_red: /);
  assert.equal(head(), start);

  const slop = await move(id, 'm3', edit('src/other.css', (s) => `${s}/* SLOP */\n`));
  assert.match(slop.result.reasons[0], /^new_detector_finding: slop\|src\/other\.css/);

  const none = await move(id, 'm4', null);
  assert.deepEqual(none.result.reasons, ['no_commit']);
  assert.equal(none.result.patch, undefined);

  const left = await move(id, 'm5', (run) => {
    edit('src/page.html', (s) => s.replace('Save', 'Store'))(run);
    wtGit(run, ['add', '-A']);
    wtGit(run, ['-c', 'user.email=d@example.com', '-c', 'user.name=d', 'commit', '-q', '-m', 'm5']);
    writeFileSync(join(run.worktree, 'src/scratch.css'), 'x{}\n');
  }, { commit: false });
  assert.ok(left.result.reasons.includes('uncommitted_changes'));
  assert.ok(G.isClean(S.loadRun(id).worktree));
  assert.equal(head(), start);
  assert.ok(existsSync(join(S.runDir(id), 'moves/m5.uncommitted.patch')));
  assert.ok(existsSync(join(S.loadRun(id).worktree, '.env.local')), 'ignored files survive the clean-up');

  // An advisory finding is not a veto, and a gate is only blamed on the move that broke it.
  const adv = await move(id, 'm6', edit('src/page.html', (s) => s.replace('Settings', 'Settings ADVISORY')));
  assert.equal(adv.result.kept, true);
  assert.equal(S.loadRun(id).moves.filter((m) => m.decision.vetoed).length, 5);
});

test('a gate that was already red is not blamed on a move', async () => {
  const red = makeApp('red', { ...CONFIG, gates: ['false', GATE] });
  const { id } = await open([issue('a')], { on: red });
  assert.match(I.prepare(id).note, /already red/);
  const r = await move(id, 'm1', edit('src/page.html', (s) => s.replace('Save', 'Save changes')));
  assert.equal(r.result.kept, true);
});

test('the comparison decides: before preferred, something broken, no difference', async () => {
  const { id } = await open(['a', 'b', 'c', 'd'].map((x) => issue(x)));
  const start = wtGit(S.loadRun(id), ['rev-parse', 'HEAD']);
  const change = (word) => edit('src/page.html', (s) => s.replace('Save', word));

  const worse = await move(id, 'm1', change('Sv'), { prefer: 'before' });
  assert.equal(worse.result.kept, false);
  assert.match(worse.result.reasons[0], /^before_preferred at /);
  assert.match(readFileSync(worse.result.patch, 'utf8'), /Sv/);
  assert.equal(wtGit(S.loadRun(id), ['rev-parse', 'HEAD']), start);
  assert.equal(S.loadRun(id).shots.m1, undefined, 'pictures of a dropped move are not kept as the current screen');

  const broken = await move(id, 'm2', change('Save everything now'), { broke: { what: 'label wraps', where: 'footer' } });
  assert.equal(broken.result.kept, false);
  assert.match(broken.result.reasons[0], /^broke at .*label wraps \(footer\)/);

  // A change the screen does not show: byte-identical pictures, so no critic is spent.
  const unseen = await move(id, 'm3', edit('src/other.css', (s) => `${s}b { color: blue }\n`));
  assert.equal(unseen.planned.critic, false);
  assert.deepEqual(unseen.result.reasons, ['no_visible_difference']);

  const same = await move(id, 'm4', change('Save!'), { prefer: 'same' });
  assert.deepEqual(same.result.reasons, ['no_visible_difference']);
  assert.equal(wtGit(S.loadRun(id), ['rev-parse', 'HEAD']), start);
  assert.equal(I.final(id).verdict, 'no_change');
  assert.equal(I.shipPlan(id).can_ship, false);
});

test('a move with nothing to see: the detector or a cited line says the issue is gone', async () => {
  const { id } = await open([issue('a', { visual: false, source: 'detector' }), issue('b', { visual: false }), issue('c', { visual: false })]);
  const fixed = await move(id, 'm1', edit('src/page.html', (s) => s.replace('SLOP\n', '')));
  assert.equal(fixed.checked.next, 'shoot', 'pictured anyway, so the next move is compared with the screen as it is');
  assert.equal(fixed.planned.critic, false, 'the detector saw the finding go');
  assert.equal(fixed.result.kept, true);
  assert.equal(S.loadRun(id).state_at, 'm1');

  const cited = await move(id, 'm2', edit('src/page.html', (s) => s.replace('<button>', '<button aria-label="Save">')), { answer: { issue_gone: true, where: 'src/page.html:2' } });
  assert.equal(cited.planned.critic, true);
  assert.ok(!existsSync(cited.planned.prompt_file), 'the check prompt is cleaned up');
  assert.equal(cited.result.kept, true);

  const uncited = await move(id, 'm3', edit('src/page.html', (s) => s.replace('<h1>', '<h1 id="t">')), { answer: { issue_gone: true, where: 'src/page.html:999' } });
  assert.equal(uncited.result.kept, false);
  assert.deepEqual(uncited.result.reasons, ['issue_still_there']);
  // Kept moves with nothing to see do not make the run unverified.
  assert.equal(I.final(id, critique([])).verdict, 'better');
});

test('a commit is only taken off the branch when all four conditions hold', async () => {
  const { id } = await open([issue('a')]);
  I.moveStart({ run: id, move: 'm1' });
  const run = S.loadRun(id);
  edit('src/page.html', (s) => s.replace('Save', 'Save changes'))(run);
  wtGit(run, ['add', '-A']);
  wtGit(run, ['-c', 'user.email=d@example.com', '-c', 'user.name=d', 'commit', '-q', '-m', 'm1']);
  const m = { id: 'm1', check: { parent: run.start_sha, sha: wtGit(run, ['rev-parse', 'HEAD']) } };
  assert.equal(G.dropRefusal(run, m), null);
  assert.match(G.dropRefusal(run, { ...m, check: { ...m.check, sha: run.start_sha } }), /HEAD is not the commit/);
  assert.match(G.dropRefusal({ ...run, shipped: true }, m), /has been pushed/);
  assert.match(G.dropRefusal({ ...run, worktree: app.repo }, m), /not this run's worktree/);
  writeFileSync(join(run.worktree, 'src/x.css'), 'x{}\n');
  assert.match(G.dropRefusal(run, m), /uncommitted/);
  assert.throws(() => G.dropHead(run, m, join(tmp, 'never.patch')), /cannot drop m1/);
  assert.ok(!existsSync(join(tmp, 'never.patch')));
});

// ---------------------------------------------------------------- task 5: final and ship
test('better: the pull request is built from what was recorded, pushed once, opened once', async () => {
  const secret = makeApp('ship', { ...CONFIG, pr: { labels: ['design'] } });
  const { id } = await open([issue('a', { problem: `the token ${TOKEN} shows in the header` }), issue('b'), issue('c', { command: 'bolder' })], { on: secret, approve: false });
  I.approve({ run: id, moves: ['m1', 'm2'], screenshots: true });
  await move(id, 'm1', edit('src/page.html', (s) => s.replace('Save', 'Save changes')));
  await move(id, 'm2', edit('src/page.html', (s) => s.replace('Settings', 'Sttngs')), { prefer: 'before' });
  assert.throws(() => I.ship(id), /no verdict/);
  const fin = I.final(id, critique([], { h1: 4 }));
  assert.deepEqual([fin.verdict, fin.kept, fin.next], ['better', ['m1'], 'ship-plan']);
  assert.deepEqual(fin.final, { total: 31, max: 40 });

  const planned = I.shipPlan(id);
  assert.equal(planned.can_ship, true);
  assert.equal(planned.draft, false);
  assert.equal(planned.base, 'main');
  assert.match(planned.title, /^Design pass on \/settings: 1 change kept$/);
  const body = planned.body.split('\n');
  assert.ok(body.length <= I.BODY_LINES + 2, `${body.length} lines`);
  assert.ok(!planned.body.includes(TOKEN));
  assert.match(planned.body, /\*\*Verdict: better\.\*\*/);
  assert.match(planned.body, /\| 30\/40 \| 31\/40 \|/);
  assert.match(planned.body, /Kept \(1\), one commit each:\n- `[0-9a-f]{7}` polish on el a/);
  assert.match(planned.body, /Tried and taken back out \(1\):\n- polish on el b: before_preferred/);
  assert.match(planned.body, /Proposed and not run \(1\):\n- bolder on el c \(a change of direction/);
  assert.deepEqual(planned.pictures.files, ['before-1440x900.png', 'after-1440x900.png', 'before-390x844.png', 'after-390x844.png']);

  const run = S.loadRun(id);
  const shipped = I.ship(id);
  assert.equal(shipped.pr, 'https://github.com/acme/app/pull/41');
  assert.equal(shipped.pictures, 4);
  const remote = (args) => execFileSync('git', ['-C', secret.bare, ...args]).toString().trim();
  assert.equal(remote(['rev-parse', `refs/heads/${run.branch}`]), wtGit(run, ['rev-parse', 'HEAD']));
  assert.deepEqual(remote(['ls-tree', '-r', '--name-only', 'design-evidence']).split('\n').sort(), ['after-1440x900.png', 'after-390x844.png', 'before-1440x900.png', 'before-390x844.png'].map((f) => `${id}/${f}`));
  assert.deepEqual(remote(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').sort(), ['design-evidence', run.branch, 'main'].sort(), 'nothing else was pushed');
  const call = calls().at(-1);
  assert.deepEqual(call.args.slice(0, 6), ['pr', 'create', '--head', run.branch, '--base', 'main']);
  assert.ok(call.args.includes('design') && !call.args.includes('--draft'));
  assert.match(call.body, /!\[before\]\(https:\/\/github\.com\/acme\/app\/blob\/[0-9a-f]{40}\//);
  assert.ok(!call.body.includes(TOKEN));

  assert.throws(() => I.ship(id), /already shipped/);
  assert.equal(I.shipPlan(id).can_ship, false);
  const stopped = await I.stop(id);
  assert.equal(stopped.worktree_removed, false, 'a run that kept something keeps its worktree');
  assert.ok(!existsSync(join(run.worktree, '.env.local')), 'copied env files are removed');

  // Merged as it stood: the kept move is recorded as an improvement.
  assert.deepEqual(I.outcome({ run: id }), { run_id: id, pr: 'MERGED', recorded: 1 });
  assert.equal(I.outcome({ run: id }).recorded, 0);
  assert.deepEqual(I.outcome({ run: id, move: 'm2', result: 'right' }).kept, false);
  assert.throws(() => I.outcome({ run: id, move: 'm3', result: 'right' }), /never ran/);
  const st = I.stats();
  assert.ok(st.runs >= 1 && st.by_verdict.better >= 1 && st.shipped >= 1 && st.outcomes.rated >= 2);
});

test('ship is refused under --no-pr, with a moved HEAD, and for a run nobody approved', async () => {
  const a = await open([issue('a')], { input: { no_pr: true } });
  await move(a.id, 'm1', edit('src/page.html', (s) => s.replace('Save', 'Save changes')));
  assert.equal(I.final(a.id, critique([])).next, 'stop');
  assert.match(I.shipPlan(a.id).why, /--no-pr/);
  assert.throws(() => I.ship(a.id), /--no-pr/);

  const b = await open([issue('a')]);
  await move(b.id, 'm1', edit('src/page.html', (s) => s.replace('Save', 'Save changes')));
  I.final(b.id, critique([]));
  const run = S.loadRun(b.id);
  writeFileSync(join(run.worktree, 'src/page.html'), 'x\n');
  assert.match(I.shipPlan(b.id).why, /uncommitted/);
  wtGit(run, ['add', '-A']);
  wtGit(run, ['-c', 'user.email=d@example.com', '-c', 'user.name=d', 'commit', '-q', '-m', 'extra']);
  assert.match(I.shipPlan(b.id).why, /HEAD is not the last kept move/);
  assert.equal(calls().filter((c) => c.args.includes(run.branch)).length, 0);
});

test('unverified: a code-only run opens a draft, and "never" cannot make it ready', async () => {
  const nodev = makeApp('draft', { gates: [GATE], ui_paths: CONFIG.ui_paths, pr: { draft: 'never' } });
  const { id, served } = await open([issue('a')], { on: nodev });
  assert.equal(served.mode, 'code_only');
  const r = await move(id, 'm1', edit('src/page.html', (s) => s.replace('Save', 'Save changes')));
  assert.equal(r.checked.next, 'compare-plan');
  assert.deepEqual([r.result.kept, r.result.unverified, r.planned.critic], [true, true, false]);
  const fin = I.final(id, critique([]));
  assert.equal(fin.verdict, 'unverified');
  const planned = I.shipPlan(id);
  assert.equal(planned.draft, true);
  assert.equal(planned.pictures, null);
  assert.match(planned.body, /Nothing was rendered/);
  assert.match(planned.body, /not seen on screen/);
});

test('mixed: a heuristic that scored lower opens a draft and says why', async () => {
  const { id } = await open([issue('a')]);
  await move(id, 'm1', edit('src/page.html', (s) => s.replace('Save', 'Save changes')));
  const fin = I.final(id, critique([], { h1: 4, h4: 2 }));
  assert.equal(fin.verdict, 'mixed');
  const planned = I.shipPlan(id);
  assert.equal(planned.draft, true);
  assert.match(planned.body, /\*\*Verdict: mixed\.\*\* scored lower than before: h4 Consistency and standards 3 to 2/);
  // A re-score that cannot be read is not a score.
  const b = await open([issue('a')]);
  await move(b.id, 'm1', edit('src/page.html', (s) => s.replace('Save', 'Save changes')));
  const unread = I.final(b.id, 'looks great');
  assert.equal(unread.verdict, 'unverified');
  assert.match(unread.reasons.join(' '), /never re-scored/);
});

// ---------------------------------------------------------------- found in review
test('a route is a plain path: nothing a shell or a pull request should not see gets through', () => {
  const { config } = loadConfig(app.repo);
  for (const bad of ['/$(touch /tmp/x)', '/a;touch /tmp/x', '/a b', "/a'b", '/a|b', '/a`id`', '/a&b']) {
    assert.match(parseTarget(config, { target: bad }).problem, /not a plain route/, bad);
    assert.match(parseTarget(config, { target: 'src/page.html', route: bad }).problem, /not a plain route/, bad);
  }
  assert.match(parseTarget(config, { target: 'http://localhost:3000/a;id' }).problem, /not a plain route/);
  // A query string is dropped wherever the route came from.
  assert.deepEqual(parseTarget(config, { target: 'src/page.html', route: '/reset?token=abc' }), { route: '/reset', file: 'src/page.html' });
  assert.deepEqual(parseTarget(config, { target: '/orders/%5Bid%5D#top' }), { route: '/orders/%5Bid%5D', file: null });
  const before = app.sh(['worktree', 'list']);
  assert.match(I.start({ repo: app.repo, target: '/settings', base: '--upload-pack=touch /tmp/x' }).problems[0], /not a branch name/);
  assert.equal(app.sh(['worktree', 'list']), before);
});

test('a file moved into a ui path is still seen under its old name', async () => {
  const { id } = await open([issue('a')]);
  const r = await move(id, 'm1', (run) => wtGit(run, ['mv', 'src/logic.js', 'src/logic.html']));
  assert.equal(r.result.vetoed, true);
  assert.match(r.result.reasons[0], /^out_of_scope: src\/logic\.js/);
});

test('a move cannot be restarted over its own commits, and history cannot be rewritten under it', async () => {
  const { id } = await open([issue('a'), issue('b')]);
  const first = I.moveStart({ run: id, move: 'm1' });
  assert.equal(I.moveStart({ run: id, move: 'm1' }).prompt_file, first.prompt_file, 'asking twice before any commit is fine');
  const run = S.loadRun(id);
  const commit = (msg, extra = []) => wtGit(run, ['-c', 'user.email=d@example.com', '-c', 'user.name=d', 'commit', '-q', ...extra, '-m', msg]);
  edit('src/page.html', (s) => s.replace('Save', 'Save changes'))(run);
  wtGit(run, ['add', '-A']);
  commit('m1');
  assert.throws(() => I.moveStart({ run: id, move: 'm1' }), /already started and has commits/);
  assert.equal(S.loadRun(id).moves[0].started.parent, run.start_sha, 'the starting point did not move');
  // The baseline cannot be replaced once a move is under way.
  assert.throws(() => I.baselineRecord(id, critique([])), /baseline is fixed/);
  assert.throws(() => I.shoot({ run: id, at: 'baseline' }), /cannot be pictured now/);
  assert.throws(() => I.shoot({ run: id, at: 'm2' }), /cannot be pictured now/);
  await move.finish(id, 'm1');
  assert.equal(S.loadRun(id).moves[0].decision.keep, true);

  // The second designer amends the first one's commit instead of adding its own.
  I.moveStart({ run: id, move: 'm2' });
  edit('src/page.html', (s) => s.replace('Settings', 'Preferences'))(run);
  wtGit(run, ['add', '-A']);
  commit('m1 rewritten', ['--amend']);
  assert.throws(() => I.moveCheck({ run: id, move: 'm2' }, '{}'), /history was rewritten/);
});

test('a viewport with no picture, or a detector that did not run, keeps a move from counting as checked', async () => {
  const a = await open([issue('a')]);
  I.moveStart({ run: a.id, move: 'm1' });
  const run = S.loadRun(a.id);
  edit('src/page.html', (s) => s.replace('Save', 'Save changes'))(run);
  wtGit(run, ['add', '-A']);
  wtGit(run, ['-c', 'user.email=d@example.com', '-c', 'user.name=d', 'commit', '-q', '-m', 'm1']);
  I.moveCheck({ run: a.id, move: 'm1' }, '{}');
  I.shoot({ run: a.id, at: 'm1' });
  const lost = S.loadRun(a.id);
  delete lost.shots.m1['390x844']; // as if that picture had failed
  S.saveRun(lost);
  const sheet = I.comparePlan({ run: a.id, move: 'm1' });
  assert.equal(sheet.pairs, 1);
  const key = S.loadRun(a.id).moves[0].compare.key;
  const res = await I.compareRecord({ run: a.id, move: 'm1' }, JSON.stringify({ pairs: Object.entries(key).map(([pair, k]) => ({ pair, prefers: k.X === 'after' ? 'X' : 'Y', x: 'x', y: 'y' })) }));
  assert.deepEqual([res.kept, res.unverified], [true, true]);
  const fin = I.final(a.id, critique([], { h1: 4 }));
  assert.equal(fin.verdict, 'unverified');
  assert.match(I.shipPlan(a.id).body, /so were the ones marked below that could not be fully checked/);

  const b = await open([issue('a')]);
  const broken = join(tmp, 'broken-detect.mjs');
  writeFileSync(broken, 'process.exit(1);\n');
  process.env.IMPROVE_DESIGN_DETECT = broken;
  try {
    const r = await move(b.id, 'm1', edit('src/page.html', (s) => s.replace('Save', 'Save changes')));
    assert.deepEqual([r.result.kept, r.result.unverified], [true, true]);
    assert.deepEqual(S.loadRun(b.id).moves[0].check.unchecked, ['the detector did not run']);
    const v = I.final(b.id, critique([], { h1: 4 }));
    assert.equal(v.verdict, 'unverified');
    assert.match(v.reasons.join(' '), /detector did not run on the result/);
    assert.match(I.shipPlan(b.id).body, /\(the detector did not run\)/);
  } finally {
    delete process.env.IMPROVE_DESIGN_DETECT;
  }
});

test('ship can be run again when the pull request could not be opened after the push', async () => {
  const again = makeApp('retry');
  const { id } = await open([issue('a')], { on: again });
  await move(id, 'm1', edit('src/page.html', (s) => s.replace('Save', 'Save changes')));
  I.final(id, critique([], { h1: 4 }));
  const stub = readFileSync(process.env.IMPROVE_DESIGN_GH_STUB, 'utf8');
  writeFileSync(process.env.IMPROVE_DESIGN_GH_STUB, '{ gh is down');
  try {
    assert.throws(() => I.ship(id));
  } finally {
    writeFileSync(process.env.IMPROVE_DESIGN_GH_STUB, stub);
  }
  const run = S.loadRun(id);
  assert.deepEqual([run.pushed, run.shipped, run.pr], [true, undefined, undefined]);
  assert.match(G.dropRefusal(run, { id: 'm1', check: run.moves[0].check }), /has been pushed/);
  assert.equal(I.ship(id).pr, 'https://github.com/acme/app/pull/41');
  assert.throws(() => I.ship(id), /already shipped: https/);
});

test('env files are never copied or removed through a link', () => {
  const outside = join(tmp, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.env'), 'S=1\n');
  const linked = makeApp('linked', CONFIG, { '.gitignore': '.env.local\nnode_modules\nlinkdir\n' });
  symlinkSync(outside, join(linked.repo, 'linkdir'));
  assert.ok(copyRefusal(linked.repo, 'linkdir/secret.env'), 'a source reached through a linked folder is refused');
  // A worktree where the destination folder is a link out of it.
  const wt = join(tmp, 'linked-wt');
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(linked.repo, 'conf'), { recursive: true });
  writeFileSync(join(linked.repo, 'conf/.env.local'), 'A=1\n');
  writeFileSync(join(linked.repo, '.gitignore'), '.env.local\nnode_modules\nlinkdir\nconf/.env.local\n');
  symlinkSync(outside, join(wt, 'conf'));
  const r = copyFiles(linked.repo, wt, ['conf/.env.local']);
  assert.deepEqual(r.copied, []);
  assert.match(r.refused[0].why, /outside the worktree/);
  assert.ok(!existsSync(join(outside, '.env.local')));
  removeCopies(wt, ['conf/secret.env']);
  assert.ok(existsSync(join(outside, 'secret.env')), 'nothing outside the worktree is removed');
});

test('only the process this run started is stopped', async () => {
  const child = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
  child.unref();
  const started = startedAt(child.pid);
  assert.ok(started);
  assert.equal(await stopServer(child.pid, 'Thu Jan  1 00:00:00 1970'), false, 'a pid that started at another time is someone else\'s');
  assert.equal(alive(child.pid), true);
  assert.equal(await stopServer(child.pid, started), true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(child.pid), false);
});

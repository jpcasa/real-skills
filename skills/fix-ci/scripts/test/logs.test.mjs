// The pure parts: what is cut from a job log, what class a failure gets, which
// commands may run here, and which shortcuts a fix takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionsLog, note, EXIT_NOTE, testJob, TEST_COMMAND } from './fixture.mjs';

const L = await import('../lib/logs.mjs');
const { classify, shape, writeWord } = await import('../lib/classes.mjs');
const { flagsOf, addedLines, FLAGS } = await import('../lib/flags.mjs');
const { compare, run: runCommand } = await import('../lib/runner.mjs');

// ---------------------------------------------------------------- logs
test('clean: timestamps, the job and step prefix, colour codes and the byte order mark go', () => {
  const lines = L.clean('Unit tests\tUNKNOWN STEP\t﻿2026-10-12T21:19:23.7732255Z Current runner\n2026-10-12T21:19:24.1Z \u001b[36;1mpnpm test\u001b[0m\r\nplain');
  assert.deepEqual(lines, ['Current runner', 'pnpm test', 'plain']);
});

test('cut: the command is the last Run group before the first error, as the runner ran it', () => {
  const c = L.cut(L.clean(testJob().log), testJob().annotations);
  assert.equal(c.command, TEST_COMMAND);
  assert.equal(c.uses, false);
  // The annotation for the exit code is not an error of the job's own.
  assert.equal(c.errors.length, 1);
  assert.deepEqual({ file: c.errors[0].file, line: c.errors[0].line }, { file: 'test/price.test.mjs', line: 9 });
  assert.equal(c.own_error, true);
  assert.match(c.excerpt, /6 !== 4/);
  assert.ok(!c.excerpt.includes('setup line 3'), 'setup is not in the excerpt');
  assert.ok(c.excerpt.split('\n').length <= L.EXCERPT_LINES);
});

test('cut: a script of several lines is kept whole; an action step is `uses`', () => {
  const multi = L.cut(L.clean(actionsLog({ script: ['result="failure"', 'if [ "$result" != "success" ]; then', '  exit 1', 'fi'], output: ['One or more shards failed.'] })));
  assert.equal(multi.script.length, 4);
  assert.equal(multi.command.split('\n')[1], 'if [ "$result" != "success" ]; then');
  assert.equal(multi.own_error, false, 'only the exit code');
  assert.match(multi.excerpt, /One or more shards failed/);
  const action = L.cut(L.clean(actionsLog({ uses: 'aws-actions/configure-aws-credentials@v4', errors: ['Input required and not supplied: aws-region'] })));
  assert.equal(action.uses, true);
  assert.equal(action.command, 'aws-actions/configure-aws-credentials@v4');
});

test('cut: without annotations the error lines are the errors; a log with no error still gives the last step', () => {
  const c = L.cut(L.clean(actionsLog({ script: 'pnpm lint', errors: ['src/a.ts(3,1): error TS2304: Cannot find name x'] })));
  assert.equal(c.errors[0].message, 'src/a.ts(3,1): error TS2304: Cannot find name x');
  assert.equal(c.errors[0].file, null);
  const none = L.cut(L.clean(actionsLog({ script: 'pnpm e2e', output: ['still waiting…'], exit: 0 })));
  assert.equal(none.command, 'pnpm e2e');
  assert.equal(none.own_error, false);
  assert.match(none.excerpt, /still waiting/);
});

test('cut: many errors are capped and counted; long lines are cut', () => {
  const errors = Array.from({ length: 30 }, (_, i) => `error ${i} ${'x'.repeat(500)}`);
  const c = L.cut(L.clean(actionsLog({ script: 'pnpm lint', errors })));
  assert.equal(c.errors.length, L.MAX_ERRORS);
  assert.equal(c.more_errors, 30 - L.MAX_ERRORS);
  for (const l of c.excerpt.split('\n')) assert.ok(l.length <= L.LINE_CHARS + 1);
});

test('signature: the same errors from two shards are one cause; different errors are not', () => {
  const e = [{ file: 'test/a.test.ts', title: 'a > b', message: 'expected 249 but got 251' }];
  const one = L.signature('pnpm exec vitest run --shard=1/2', e);
  assert.equal(one, L.signature('pnpm exec vitest run --shard=2/2', [{ ...e[0], message: 'expected 12 but got 14' }]));
  assert.notEqual(one, L.signature('pnpm exec vitest run --shard=2/2', [{ file: 'test/c.test.ts', title: 'c', message: 'boom' }]));
  assert.notEqual(one, L.signature('pnpm lint', e));
  // Two packages that fail alike are still two commands to prove.
  assert.notEqual(L.signature('pnpm -F app1 test', e), L.signature('pnpm -F app2 test', e));
});

test('needles: file names and error lines long enough to mean something', () => {
  assert.deepEqual(L.needles([{ file: 'app/tests/unit/price.test.ts', message: 'AssertionError: expected 4\n\n- 4' }, { file: null, message: 'boom' }]), ['price.test.ts', 'AssertionError: expected 4']);
  assert.deepEqual(L.needles([]), []);
});

test('compare: green, red for the same reason, red for another, and a command that could not start', () => {
  const needles = ['price.test.mjs'];
  assert.equal(compare({ ok: true, exit: 0, text: '' }, needles).result, 'not_reproduced');
  assert.equal(compare({ ok: false, exit: 1, text: 'fail at test/price.test.mjs:9' }, needles).result, 'reproduced');
  assert.equal(compare({ ok: false, exit: 1, text: 'Error: Cannot find module x' }, needles).result, 'differs');
  assert.equal(compare({ ok: false, exit: 127, text: 'sh: pnpm: command not found' }, []).result, 'differs');
  assert.equal(compare({ ok: false, exit: null, timed_out: true, text: '' }, needles).result, 'differs');
  // CI gave nothing to compare with: a red exit is all there is.
  assert.equal(compare({ ok: false, exit: 2, text: 'whatever' }, []).result, 'reproduced');
});

// ---------------------------------------------------------------- classes
const base = { actions: true, log_read: true, conclusion: 'failure', error_texts: [], excerpt: '', own_error: false, in_a_file: false, repro: 'run', sibling_failed: false, reran: false };
test('classify: each class, with the fact that decided it', () => {
  assert.equal(classify({ ...base, actions: false }).class, 'external');
  assert.equal(classify({ ...base, log_read: false }).class, 'external');
  assert.equal(classify({ ...base, conclusion: 'timed_out' }).class, 'infra');
  assert.equal(classify({ ...base, conclusion: 'cancelled' }).class, 'infra');
  const net = classify({ ...base, own_error: true, error_texts: ['npm ERR! network request failed, reason: read ECONNRESET'] });
  assert.equal(net.class, 'infra');
  assert.match(net.evidence, /a network error: npm ERR!/);
  const perm = classify({ ...base, own_error: true, error_texts: ['Resource not accessible by integration'] });
  assert.equal(perm.class, 'config');
  assert.match(perm.evidence, /lacks a permission/);
  assert.equal(classify({ ...base, own_error: true, error_texts: ['Input required and not supplied: token'] }).class, 'config');
  assert.equal(classify({ ...base, own_error: true, error_texts: ['TS2304: Cannot find name x'] }).class, 'code');
  // Nothing but an exit code: the excerpt is read too.
  assert.equal(classify({ ...base, excerpt: 'Error: No space left on device' }).class, 'infra');
  assert.equal(classify(base).class, 'code');
});

test('classify: an error in a file of the repo is the code\'s, whatever its message says', () => {
  const c = classify({ ...base, own_error: true, in_a_file: true, error_texts: ['expected "401 Unauthorized" to equal "200 OK"\nECONNRESET'] });
  assert.equal(c.class, 'code');
});

test('classify: a job that only sums up others is derived; a rerun that is red again is code', () => {
  assert.equal(classify({ ...base, repro: 'ask', sibling_failed: true }).class, 'derived');
  assert.equal(classify({ ...base, repro: 'ask', sibling_failed: false }).class, 'code');
  assert.equal(classify({ ...base, repro: 'run', sibling_failed: true }).class, 'code', 'a real command is not a summary');
  const again = classify({ ...base, conclusion: 'timed_out', reran: true });
  assert.equal(again.class, 'code');
  assert.match(again.evidence, /red again after a rerun/);
});

test('shape: one line of checking tools runs; anything else is shown first', () => {
  for (const cmd of ['pnpm test', 'pnpm exec vitest run --globals --shard=2/2', 'npm run lint', 'CI=true yarn typecheck', 'cd app && pnpm lint && pnpm format:check', 'node --test test/', 'cargo build --release', 'go test ./...', 'pytest -q tests/unit', 'pnpm install --frozen-lockfile', 'poetry run pytest -q', 'uv run ruff check', 'python -m pytest', 'bundle exec rspec', 'biome check --apply src'])
    assert.equal(shape([cmd]).repro, 'run', cmd);
  for (const cmd of ['make test', './scripts/check.sh', 'pnpm test | tee out.txt', 'pnpm test > out.txt', 'echo $(pnpm test)', 'npx some-tool', 'pnpm dlx some-tool', 'npm exec some-tool', 'bun x some-tool', 'sh ./run-tests.sh', 'cd ../other && pnpm test', 'cd /srv/other && pnpm test', 'pnpm exec git status', 'node -e "run()"', 'python3 -c "run()"', 'npm install -g some-tool', 'pnpm link ../x', 'NODE_OPTIONS=--require=./x.js pnpm test', 'npm_config_registry=https://example.com pnpm install', 'pnpm vitest run ${FILES}'])
    assert.equal(shape([cmd]).repro, 'ask', cmd);
  assert.equal(shape(['pnpm lint', 'pnpm test']).repro, 'ask', 'several lines');
  assert.match(shape(['make test']).why, /`make` is not on the list/);
});

test('shape: a command that writes somewhere is never run here', () => {
  for (const cmd of ['pnpm deploy', 'npm publish', 'pnpm db:migrate', 'terraform apply -auto-approve', 'pnpm drizzle-kit push', 'aws s3 sync dist s3://bucket', 'vercel --prod', 'docker push acme/app', 'gh release create v1', 'curl -X POST https://example.com', 'pnpm run release', 'node scripts/deploy.mjs', 'python3 scripts/release.py', 'pnpm run predeploy', 'pnpm exec git pu\\sh origin HEAD:main', 'pnpm exec "git" \'push\''])
    assert.equal(shape([cmd]).repro, 'never', cmd);
  // One level into the package scripts.
  const viaScript = shape(['pnpm ship'], { scripts: { ship: 'vercel deploy --prod' } });
  assert.equal(viaScript.repro, 'never');
  assert.match(viaScript.why, /package script `ship` names `deploy`/);
  assert.equal(shape(['pnpm test'], { scripts: { test: 'vitest run' } }).repro, 'run');
  // A step that is an action has no command to run.
  assert.equal(shape(['actions/setup-node@v4'], { uses: true }).repro, 'never');
  assert.equal(shape([]).repro, 'never');
  assert.equal(writeWord('cargo build --release'), null, 'a flag is not a command');
  assert.equal(writeWord('pnpm lint .github/scripts'), null);
  assert.equal(writeWord('pnpm test --no-deploy-check'), null);
  assert.equal(writeWord('g\\h pr merge 7'), 'gh', 'read as the shell reads it');
});

test('shape: the config wins: a command for the job, or never', () => {
  assert.deepEqual(shape(['make test'], { mapped: 'pnpm test' }), { repro: 'run', why: 'the command the config gives for this job', command: 'pnpm test' });
  assert.equal(shape(['pnpm test'], { mapped: false }).repro, 'never');
});

// ---------------------------------------------------------------- flags
const flags = (changes, failures = [], opts = {}) => flagsOf(changes, failures, opts).map((f) => f.id).sort();
test('flags: a plain fix to the code takes no shortcut', () => {
  assert.deepEqual(flags([{ file: 'src/price.ts', before: 'export const p = (n) => n * 3;\n', after: 'export const p = (n) => n * 2;\n' }]), []);
});

test('flags: each shortcut is caught', () => {
  assert.deepEqual(flags([{ file: '.github/workflows/ci.yml', before: 'a', after: 'b' }]), ['ci_config:.github/workflows/ci.yml']);
  assert.deepEqual(flags([{ file: 'app/tsconfig.json', before: '{}', after: '{"strict":false}' }]), ['check_config:app/tsconfig.json']);
  assert.deepEqual(flags([{ file: 'eslint.config.mjs', before: 'a', after: 'b' }]), ['check_config:eslint.config.mjs']);
  assert.deepEqual(flags([{ file: 'tools/rules.json', before: 'a', after: 'b' }], [], { check_config: ['tools/**'] }), ['check_config:tools/rules.json']);
  assert.deepEqual(flags([{ file: 'test/a.test.ts', before: 'it("a", f)\n', after: null }]), ['test_removed:test/a.test.ts']);
  assert.deepEqual(flags([{ file: 'test/a.test.ts', before: 'it("a", f)\nit("b", g)\n', after: 'it("a", f)\n' }]), ['test_removed:test/a.test.ts']);
  assert.deepEqual(flags([{ file: 'test/a.test.ts', before: 'it("a", f)\n', after: 'it.skip("a", f)\n' }]), ['test_skipped:test/a.test.ts']);
  assert.deepEqual(flags([{ file: 'tests/test_a.py', before: 'def test_a():\n  pass\n', after: '@pytest.mark.skip\ndef test_a():\n  pass\n' }]), ['test_skipped:tests/test_a.py']);
  assert.deepEqual(flags([{ file: 'src/a.ts', before: 'const a = b;\n', after: '// @ts-ignore\nconst a = b;\n' }]), ['suppression:src/a.ts']);
  assert.deepEqual(flags([{ file: 'src/a.ts', before: 'const a = b;\n', after: 'const a = b as any;\n' }]), ['suppression:src/a.ts']);
  assert.deepEqual(flags([{ file: 'src/a.py', before: 'x = f()\n', after: 'x = f()  # type: ignore\n' }]), ['suppression:src/a.py']);
  assert.deepEqual(flags([{ file: 'src/__snapshots__/a.test.ts.snap', before: 'a', after: 'b' }]), ['snapshot:src/__snapshots__/a.test.ts.snap']);
  assert.deepEqual(flags([{ file: 'pnpm-lock.yaml', before: 'a', after: 'b' }]), ['dependencies:pnpm-lock.yaml']);
  assert.deepEqual(flags([{ file: 'package.json', before: '{"dependencies":{"a":"1"}}', after: '{"dependencies":{"a":"2"}}' }]), ['dependencies:package.json']);
});

test('flags: what is not a shortcut is not asked', () => {
  // A package script is what a check runs: `vitest run || true` is green and fixes nothing.
  assert.deepEqual(flags([{ file: 'package.json', before: '{"scripts":{"test":"vitest run"},"dependencies":{"a":"1"}}', after: '{"scripts":{"test":"vitest run || true"},"dependencies":{"a":"1"}}' }]), ['check_config:package.json']);
  // Another key of package.json is neither.
  assert.deepEqual(flags([{ file: 'package.json', before: '{"description":"a","scripts":{"a":"x"}}', after: '{"description":"b","scripts":{"a":"x"}}' }]), []);
  // A suppression that was already there is not the fix's.
  assert.deepEqual(flags([{ file: 'src/a.ts', before: '// @ts-ignore\nconst a = b;\n', after: '// @ts-ignore\nconst a = c;\n' }]), []);
  // A new test, and a test nobody named, edited: fine.
  assert.deepEqual(flags([{ file: 'test/new.test.ts', before: null, after: 'it("a", f)\n' }]), []);
  assert.deepEqual(flags([{ file: 'test/a.test.ts', before: 'it("a", f)\n', after: 'it("a", g)\n' }]), []);
});

test('flags: editing the test a failure names is asked; so is a fix that is large', () => {
  const failures = [{ errors: [{ file: 'app/test/a.test.ts' }] }];
  assert.deepEqual(flags([{ file: 'app/test/a.test.ts', before: 'it("a", f)\n', after: 'it("a", g)\n' }], failures), ['test_edited:app/test/a.test.ts']);
  const many = Array.from({ length: 11 }, (_, i) => ({ file: `src/f${i}.ts`, before: 'a', after: 'b' }));
  assert.deepEqual(flags(many), ['large:*']);
  assert.deepEqual(flags([{ file: 'src/a.ts', before: 'a', after: 'b' }], [], { lines_changed: 301 }), ['large:*']);
  assert.deepEqual(flags(many, [], { max_files: 20 }), []);
});

test('flags: an answer is for one content of the file', () => {
  const at = (after) => flagsOf([{ file: 'test/a.test.ts', before: 'it("a", f)\n', after }], [], {})[0].hash;
  assert.equal(at('it.skip("a", f)\n'), at('it.skip("a", f)\n'));
  assert.notEqual(at('it.skip("a", f)\n'), at('it.skip("a", g)\n'));
  assert.deepEqual(addedLines('a\nb\n', 'a\nb\nb\nc\n'), ['b', 'c']);
  for (const f of ['ci_config', 'check_config', 'test_removed', 'test_skipped', 'test_edited', 'suppression', 'snapshot', 'dependencies', 'large']) assert.ok(FLAGS.includes(f));
});

test('the exit-code annotation alone is not an error of the job', () => {
  const c = L.cut(L.clean(actionsLog({ script: 'pnpm test' })), [EXIT_NOTE, note('a.ts', 1, 'real')]);
  assert.equal(c.errors.length, 1);
  assert.equal(L.headline(c.errors), 'real');
});

test('a command that runs out of time is killed with everything it started', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-kill-'));
  // The shell waits on a child of its own: killing the shell alone would leave the child running.
  const r = runCommand(dir, 'sleep 61.375; true', { timeoutS: 1, log: join(dir, 'out.log') });
  assert.equal(r.timed_out, true);
  assert.equal(r.ok, false);
  let left = '';
  try {
    left = execFileSync('pgrep', ['-f', 'sleep 61.375']).toString().trim();
  } catch {}
  assert.equal(left, '', 'nothing of the command is still running');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const H = await import('../lib/hunks.mjs');
const K = await import('../lib/classes.mjs');

// The conflicted copy the script builds: `git merge-file` on the three versions.
function conflicted(pr, origin, base) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-hunks-'));
  const size = H.markerSize([pr, origin, base]);
  for (const [n, t] of [['pr', pr], ['origin', origin], ['base', base]]) writeFileSync(join(dir, n), t);
  let text;
  try {
    text = execFileSync('git', ['merge-file', '-p', '--zdiff3', `--marker-size=${size}`, '-L', 'pr', '-L', 'origin', '-L', 'base', 'pr', 'origin', 'base'], { cwd: dir }).toString();
  } catch (e) {
    text = e.stdout.toString();
  }
  return { text, size, segments: H.parse(text, size) };
}

const ORIGIN = 'import a from "a";\n\nexport function price(n) {\n  return n * 2;\n}\n\nexport const LIMIT = 10;\n';
const PR = 'import a from "a";\nimport tax from "tax";\n\nexport function price(n, region) {\n  return n * 2;\n}\n\nexport const LIMIT = 10;\n';
const BASE = 'import a from "a";\nimport log from "log";\n\nexport function price(amount) {\n  return amount * 2;\n}\n\nexport const LIMIT = 10;\n';

test('parse: two hunks, each with the three texts, and the rest as plain text', () => {
  const { segments } = conflicted(PR, ORIGIN, BASE);
  const hunks = H.hunksOf(segments);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].pr, ['import tax from "tax";']);
  assert.deepEqual(hunks[0].base, ['import log from "log";']);
  assert.deepEqual(hunks[0].origin, []);
  assert.deepEqual(hunks[1].origin, ['export function price(n) {', '  return n * 2;']);
  assert.deepEqual(hunks.map((h) => h.id), [1, 2]);
  assert.ok(hunks[1].line > hunks[0].line);
});

test('render: unresolved hunks keep their markers, resolved ones are written, the rest is untouched', () => {
  const { text, size, segments } = conflicted(PR, ORIGIN, BASE);
  assert.equal(H.render(segments, {}, size), text);
  const half = H.render(segments, { 1: { kind: 'both', first: 'base' } }, size);
  assert.match(half, /import log from "log";\nimport tax from "tax";\n/);
  assert.match(half, /<<<<<<< pr\n/);
  const done = H.render(segments, { 1: { kind: 'both', first: 'pr' }, 2: { kind: 'combined', text: 'export function price(amount, region) {\n  return amount * 2;\n' } }, size);
  assert.equal(done, 'import a from "a";\nimport tax from "tax";\nimport log from "log";\n\nexport function price(amount, region) {\n  return amount * 2;\n}\n\nexport const LIMIT = 10;\n');
  assert.equal(H.render(segments, { 1: { kind: 'pr' }, 2: { kind: 'base' } }, size), BASE.replace('import log from "log";', 'import tax from "tax";'));
});

test('a file with marker-like lines gets a longer marker, and still parses', () => {
  const origin = 'Title\n=======\n\ntext\n';
  const { size, segments } = conflicted('Title\n=======\n\nmine\n', origin, 'Title\n=======\n\ntheirs\n');
  assert.equal(size, 8);
  const [h] = H.hunksOf(segments);
  assert.deepEqual([h.pr, h.origin, h.base], [['mine'], ['text'], ['theirs']]);
  assert.equal(H.render(segments, { 1: { kind: 'pr' } }, size), 'Title\n=======\n\nmine\n');
});

test('both added the file: no origin text', () => {
  const { segments } = conflicted('a = 1\n', '', 'b = 2\n');
  const [h] = H.hunksOf(segments);
  assert.deepEqual([h.pr, h.origin, h.base], [['a = 1'], [], ['b = 2']]);
});

test('an unclosed conflict is an error, not a guess', () => {
  assert.throws(() => H.parse('<<<<<<< pr\na\n=======\nb\n'), /never closes/);
});

test('hunkAsk: both is free only where both sides added lines', () => {
  const [imports, signature] = H.hunksOf(conflicted(PR, ORIGIN, BASE).segments);
  assert.equal(H.hunkAsk(imports, { kind: 'both', first: 'pr' }), null);
  assert.match(H.hunkAsk(signature, { kind: 'both', first: 'pr' }), /two versions/);
});

test('hunkAsk: both is asked when the two sides added largely the same lines', () => {
  const block = (id, extra) => `  {\n    id: '${id}',\n    owner: 'forms',\n    category: 'seed',\n    retries: 3,\n${extra}  },\n`;
  const origin = 'export const fixtures = [\n];\n';
  const [h] = H.hunksOf(conflicted(`export const fixtures = [\n${block('dev-routes', "    env: 'dev',\n")}];\n`, origin, `export const fixtures = [\n${block('routes', '')}];\n`).segments);
  assert.deepEqual(h.origin, []);
  assert.ok(H.overlap(h) >= H.SAME_LINES);
  assert.match(H.hunkAsk(h, { kind: 'both', first: 'pr' }), /largely the same lines here, so writing both repeats them/);
  // Two entries with nothing in common are simply two entries.
  const [two] = H.hunksOf(conflicted("list = [\n  'alpha-one',\n]\n", 'list = [\n]\n', "list = [\n  'beta-two',\n]\n").segments);
  assert.equal(H.overlap(two), 0);
  assert.equal(H.hunkAsk(two, { kind: 'both', first: 'pr' }), null);
});

test('hunkAsk: one side is free when the other only added lines the kept side has too', () => {
  const origin = 'a = 1\n';
  const [h] = H.hunksOf(conflicted('a = 1\nuse(alpha)\n', origin, 'a = 1\nuse(alpha)\nuse(beta)\n').segments);
  assert.deepEqual(h.origin, []);
  assert.equal(H.hunkAsk(h, { kind: 'base' }), null);
  assert.match(H.hunkAsk(h, { kind: 'pr' }), /what the base did to these lines is dropped/);
  // Not when lines that were already there are involved: the dropped side may have removed one on purpose.
  const [, signature] = H.hunksOf(conflicted(PR, ORIGIN, BASE).segments);
  assert.match(H.hunkAsk(signature, { kind: 'base' }), /what the pull request did/);
});

test('hunkAsk: a short line is a change too, and so is a line of brackets', () => {
  // Both only added: one side `i++`, the other a call. Neither has the other's line.
  const [h] = H.hunksOf(conflicted('a = 1\ni++\n', 'a = 1\n', 'a = 1\nfoo();\n').segments);
  assert.deepEqual([h.pr, h.origin, h.base], [['i++'], [], ['foo();']]);
  assert.match(H.hunkAsk(h, { kind: 'base' }), /what the pull request did to these lines is dropped/);
  assert.match(H.hunkAsk(h, { kind: 'pr' }), /what the base did/);
  // A closing line one side added and the combined text lost.
  const [b] = H.hunksOf(conflicted('run(() => {\n});\n', '', 'setup()\n').segments);
  assert.deepEqual(H.missingMarks(b, ['setup()', 'run(() => {']), ['});']);
  assert.match(H.hunkAsk(b, { kind: 'combined', text: 'setup()\nrun(() => {\n' }), /leaves out `}\);`/);
  assert.equal(H.hunkAsk(b, { kind: 'combined', text: 'setup()\nrun(() => {\n});\n' }), null);
});

test('a combined text keeps the file\'s Windows line endings', () => {
  const { segments, size } = conflicted('a\r\nmine\r\nz\r\n', 'a\r\nold\r\nz\r\n', 'a\r\ntheirs\r\nz\r\n');
  assert.equal(H.render(segments, { 1: { kind: 'combined', text: 'mine theirs\nmore\n' } }, size), 'a\r\nmine theirs\r\nmore\r\nz\r\n');
});

test('hunkAsk: combined is free when every name either side added is still there, and names what is not', () => {
  const [, signature] = H.hunksOf(conflicted(PR, ORIGIN, BASE).segments);
  assert.equal(H.hunkAsk(signature, { kind: 'combined', text: 'export function price(amount, region) {\n  return amount * 2;\n' }), null);
  const ask = H.hunkAsk(signature, { kind: 'combined', text: 'export function price(amount) {\n  return amount * 2;\n' });
  assert.match(ask, /leaves out `region`/);
  assert.deepEqual(H.missingTokens(signature, ['export function price(n) {']), ['amount', 'region']);
});

test('hunkAsk: one side is free only when the other differs by whitespace', () => {
  const [h] = H.hunksOf(conflicted('if (a) {\n    go();\n}\n', 'if (a) go();\n', 'if (a) {\n  go();\n}\n').segments);
  assert.equal(H.hunkAsk(h, { kind: 'pr' }), null);
  const [, signature] = H.hunksOf(conflicted(PR, ORIGIN, BASE).segments);
  assert.match(H.hunkAsk(signature, { kind: 'pr' }), /what the base did to these lines is dropped/);
  assert.match(H.hunkAsk(signature, { kind: 'base' }), /what the pull request did/);
});

test('classify: by the two status letters, then by name', () => {
  const config = { generated: [{ glob: 'src/gen/**', command: 'make gen' }], lockfiles: { 'deps.lock': 'tool lock' } };
  const c = (xy, path, binary = false) => K.classify({ xy, path, binary, config });
  assert.deepEqual(c('UU', 'src/a.ts'), { class: 'content' });
  assert.deepEqual(c('AA', 'src/a.ts'), { class: 'content' });
  assert.deepEqual(c('UU', 'img/a.png', true), { class: 'binary' });
  assert.deepEqual(c('UU', 'web/pnpm-lock.yaml'), { class: 'lockfile' });
  assert.deepEqual(c('UU', 'deps.lock'), { class: 'lockfile' });
  assert.deepEqual(c('UU', 'src/gen/api.ts'), { class: 'generated' });
  assert.deepEqual(c('UD', 'src/a.ts'), { class: 'modify_delete', modified: 'pr' });
  assert.deepEqual(c('DU', 'pnpm-lock.yaml'), { class: 'modify_delete', modified: 'base' });
  assert.deepEqual(c('AU', 'src/new.ts'), { class: 'structural', has: 'pr' });
  assert.deepEqual(c('UA', 'src/new.ts'), { class: 'structural', has: 'base' });
  assert.deepEqual(c('DD', 'src/old.ts'), { class: 'structural', has: null });
  assert.throws(() => c('M.', 'src/a.ts'), /not an unmerged path/);
  assert.deepEqual(Object.keys(K.KINDS), K.CLASSES);
});

test('lockCommand: the table, the config, and yarn by version', () => {
  assert.match(K.lockCommand('web/pnpm-lock.yaml'), /^pnpm install --lockfile-only --ignore-scripts$/);
  assert.equal(K.lockCommand('yarn.lock', {}, { berry: true }), 'yarn install --mode update-lockfile');
  assert.equal(K.lockCommand('yarn.lock'), 'yarn install --ignore-scripts');
  assert.equal(K.lockCommand('deps.lock', { lockfiles: { 'deps.lock': 'tool lock' } }), 'tool lock');
  assert.equal(K.lockCommand('pnpm-lock.yaml', { lockfiles: { 'pnpm-lock.yaml': 'pnpm i --lockfile-only' } }), 'pnpm i --lockfile-only');
  assert.equal(K.lockCommand('other.lock'), null);
  // Every node package manager command keeps install scripts off.
  for (const [name, cmd] of Object.entries(K.LOCKFILES)) if (/^(npm|pnpm|yarn|bun) /.test(cmd)) assert.match(cmd, /--ignore-scripts/, name);
});

test('fileAsk: regenerate and a path both sides removed are free; everything else is asked', () => {
  assert.equal(K.fileAsk({ class: 'lockfile' }, 'regenerate'), null);
  assert.match(K.fileAsk({ class: 'modify_delete', modified: 'pr' }, 'port', 'src/new.ts'), /carried to src\/new\.ts by hand; whether that is where the code went is a call/);
  assert.equal(K.fileAsk({ class: 'structural', has: null }, 'delete'), null);
  assert.match(K.fileAsk({ class: 'modify_delete', modified: 'pr' }, 'delete'), /the base deleted this file and the pull request changed it; deleting it drops that change/);
  assert.match(K.fileAsk({ class: 'modify_delete', modified: 'base' }, 'keep'), /undoes the deletion/);
  assert.match(K.fileAsk({ class: 'binary' }, 'base'), /whole file is taken from the base/);
  assert.match(K.fileAsk({ class: 'lockfile' }, 'pr'), /whole file is taken from the pull request/);
  assert.match(K.fileAsk({ class: 'structural', has: 'base' }, 'keep'), /only on the base's side/);
});

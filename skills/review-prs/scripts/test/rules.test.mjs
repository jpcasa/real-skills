// The pure rules: diff parsing, ignores, chunking, lens choice, the citation
// check, the drop rules in order, and the verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePatch, isIgnored, chunk } from '../lib/diff.mjs';
import { pickLenses } from '../lib/lenses.mjs';
import { checkCitation, applyRules, verdict, overCaps, MAX_NITS } from '../lib/rules.mjs';

const PATCH = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 1111111..2222222 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -8,4 +8,5 @@ export function check(token) {
   const now = Date.now();
-  if (token.expires <= now) return false;
+  if (token.expires < now) return false;
+  audit(token);
   return true;
 }
diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,2 +1,2 @@
-export const a = 1;
+export const a = 2;
 export const b = 3;
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const x = 1;
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`;
const HEAD = {
  'src/auth/session.ts': ['// session', '', '', '', '', '', 'export function check(token) {', '  const now = Date.now();', '  if (token.expires < now) return false;', '  audit(token);', '  return true;', '}', '', '', '', 'export const far = 1;'].join('\n'),
  'new/name.ts': 'export const a = 2;\nexport const b = 3;\n',
};
const files = parsePatch(PATCH);
const ctx = { files, headText: (f) => HEAD[f] ?? null };
const F = (o) => ({ id: 'correctness#0', lens: 'correctness', severity: 'bug', file: 'src/auth/session.ts', line: 9, quote: 'if (token.expires < now) return false;', problem: 'Expiry check uses <.', fix: 'Use <=.', ...o });
const ok = (o) => checkCitation(F(o), ctx);

test('parsePatch: files, renames, deletions, binaries, new-side lines', () => {
  assert.deepEqual(files.map((f) => f.file), ['src/auth/session.ts', 'new/name.ts', 'gone.ts', 'logo.png']);
  const [s, r, d, b] = files;
  assert.deepEqual([...s.lines], [8, 9, 10, 11, 12]);
  assert.deepEqual([s.added, s.removed], [2, 1]);
  assert.equal(r.old_file, 'old/name.ts');
  assert.deepEqual([...r.lines], [1, 2]);
  assert.equal(d.deleted, true);
  assert.equal(b.binary, true);
});

test('parsePatch: a path with a space, and a C-quoted path', () => {
  const spaced = parsePatch('diff --git a/my file.txt b/my file.txt\n--- a/my file.txt\t\n+++ b/my file.txt\t\n@@ -1 +1 @@\n-a\n+b\n');
  assert.deepEqual([spaced[0].file, [...spaced[0].lines]], ['my file.txt', [1]]);
  const quoted = parsePatch('diff --git "a/tab\\there.txt" "b/tab\\there.txt"\n--- "a/tab\\there.txt"\n+++ "b/tab\\there.txt"\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(quoted[0].file, 'tab\there.txt');
  const added = parsePatch('diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n');
  assert.equal(added[0].file, 'new.ts');
});

test('ignore list: built-in and extra globs', () => {
  assert.equal(isIgnored('src/a.ts', ['src/{oops']), false, 'an unclosed brace is a literal, not a hang');
  for (const p of ['pnpm-lock.yaml', 'apps/web/package-lock.json', 'a/__snapshots__/x.snap', 'dist/app.js', 'img/logo.png', 'x.min.js']) assert.ok(isIgnored(p), p);
  for (const p of ['src/app.ts', 'README.md', 'db/schema.sql']) assert.ok(!isIgnored(p), p);
  assert.ok(isIgnored('packages/api/gen/types.ts', ['packages/api/gen/**']));
});

test('chunk: one chunk when it fits, split at the limit, overflow listed', () => {
  const f = (file, added) => ({ file, added, removed: 0 });
  assert.deepEqual(chunk([f('a/x', 10), f('b/y', 20)]), { chunks: [['a/x', 'b/y']], not_reviewed: [] });
  assert.deepEqual(chunk([]), { chunks: [], not_reviewed: [] });
  const big = chunk([f('a/1', 60), f('a/2', 60), f('b/1', 60), f('c/1', 60), f('d/1', 200), f('e/1', 60)], { limit: 100, max: 3 });
  assert.deepEqual(big.chunks, [['a/1'], ['a/2'], ['b/1']]);
  assert.deepEqual(big.not_reviewed, ['c/1', 'd/1', 'e/1']);
  // A file over the limit still gets a chunk to itself.
  assert.deepEqual(chunk([f('a/huge', 500), f('b/s', 10)], { limit: 100, max: 4 }).chunks, [['a/huge'], ['b/s']]);
});

test('lens choice: defaults, a path rule, --lens, unknown lens', () => {
  assert.deepEqual(pickLenses({ files: ['README.md'] }).lenses, ['correctness', 'standards']);
  const p = pickLenses({ files: ['src/auth/session.ts', 'db/migrations/1.sql', 'ui/Button.tsx'] });
  assert.deepEqual(p.lenses, ['correctness', 'standards', 'security', 'data', 'performance', 'accessibility']);
  assert.match(p.reasons.security, /path rule: src\/auth/);
  assert.deepEqual(pickLenses({ files: ['a.ts'], forced: ['performance'] }).reasons.performance, '--lens');
  assert.deepEqual(pickLenses({ files: ['apps/billing/x.ts'], pathRules: [{ pattern: '^apps/billing/', lenses: ['security'] }] }).lenses, ['correctness', 'standards', 'security']);
  assert.throws(() => pickLenses({ forced: ['vibes'] }), /unknown lens/);
});

test('citation: verified, in the diff, and the failures', () => {
  assert.deepEqual([ok().verified, ok().in_diff], [true, true]);
  assert.match(ok({ file: 'src/nope.ts' }).problem_with, /not in this PR/);
  assert.match(ok({ file: 'gone.ts', line: 1 }).problem_with, /deleted or binary/);
  assert.match(ok({ line: 99 }).problem_with, /out of range/);
  assert.match(ok({ line: 1, quote: 'if (token.expires < now) return false;' }).problem_with, /not found within 3 lines/);
  assert.match(ok({ quote: 'return' }).problem_with, /too short/);
  assert.match(ok({ quote: '' }).problem_with, /too short/);
});

test('citation: an off-by-a-few line is moved to where the quote is', () => {
  const c = ok({ line: 11 });
  assert.equal(c.verified, true);
  assert.equal(c.line, 9);
  // A short quote counts when it is the whole line.
  assert.equal(ok({ line: 10, quote: 'audit(token);' }).verified, true);
  assert.equal(ok({ line: 12, quote: '}' }).verified, true);
});

test('citation: a real line outside every hunk is verified but not in the diff', () => {
  const c = ok({ line: 16, quote: 'export const far = 1;' });
  assert.deepEqual([c.verified, c.in_diff], [true, false]);
  assert.equal(ok({ file: 'new/name.ts', line: 2, quote: 'export const b = 3;' }).in_diff, true, 'context line of a renamed file');
});

test('rules: unverified dropped, already raised dropped', () => {
  const r = applyRules({ findings: [ok({ line: 99 }), ok()], existing: [] });
  assert.equal(r.dropped.citation, 1);
  assert.equal(r.kept.length, 1);
  const near = [{ path: 'src/auth/session.ts', line: 11 }];
  const raised = applyRules({ findings: [ok({ severity: 'risk' })], existing: near });
  assert.equal(raised.dropped.already_raised, 1);
  assert.equal(raised.kept.length, 0);
  // The nearby comment may be about something else: a bug or a security finding stays, marked.
  for (const f of [ok(), ok({ severity: 'nit', lens: 'security' })]) {
    const kept = applyRules({ findings: [f], existing: near });
    assert.deepEqual([kept.dropped.already_raised, kept.kept.length, kept.kept[0].near_comment], [0, 1, true]);
  }
  assert.equal(applyRules({ findings: [ok({ severity: 'risk' })], existing: [{ path: 'src/auth/session.ts', line: 30 }, { path: 'other.ts', line: 9 }] }).kept.length, 1);
});

test('rules: nearby findings merge into one place and lose nothing', () => {
  const a = ok({ id: 'standards#0', lens: 'standards', severity: 'nit', line: 10, quote: 'audit(token);', problem: 'Audit call is unnamed.', fix: 'Name it.' });
  const r = applyRules({ findings: [a, ok()] });
  assert.equal(r.kept.length, 1);
  assert.equal(r.merged, 1);
  assert.equal(r.kept[0].severity, 'bug');
  assert.deepEqual(r.kept[0].lenses.sort(), ['correctness', 'standards']);
  assert.deepEqual(r.kept[0].also, [{ lens: 'standards', severity: 'nit', line: 10, problem: 'Audit call is unnamed.', fix: 'Name it.' }]);
});

test('rules: a bug is refuted only with a verified citation', () => {
  const cite = checkCitation({ file: 'src/auth/session.ts', line: 8, quote: 'const now = Date.now();' }, ctx);
  const bad = checkCitation({ file: 'src/auth/session.ts', line: 8, quote: 'this text is not in the file' }, ctx);
  const ref = (o) => [{ id: 'correctness#0', refuted: true, reason: 'expires is exclusive by contract', cite, ...o }];
  assert.equal(applyRules({ findings: [ok()], refutations: ref() }).dropped.refuted, 1);
  const unsure = applyRules({ findings: [ok()], refutations: ref({ refuted: false }) });
  assert.deepEqual([unsure.dropped.refuted, unsure.kept.length], [0, 1]);
  const uncited = applyRules({ findings: [ok()], refutations: ref({ cite: bad }) });
  assert.equal(uncited.kept.length, 1);
  assert.match(uncited.kept[0].refuter_note, /without a checkable citation/);
  assert.equal(applyRules({ findings: [ok()], refutations: ref({ cite: undefined }) }).kept.length, 1);
  // Refutation never applies below bug level.
  assert.equal(applyRules({ findings: [ok({ severity: 'risk' })], refutations: ref() }).kept.length, 1);
});

test('rules: a security finding is never dropped by the refuter', () => {
  const cite = checkCitation({ file: 'src/auth/session.ts', line: 8, quote: 'const now = Date.now();' }, ctx);
  const sec = ok({ lens: 'security', problem: 'SECURITY: The expiry check accepts an expired token for one tick.' });
  const r = applyRules({ findings: [sec], refutations: [{ id: 'correctness#0', refuted: true, reason: 'not reachable', cite }] });
  assert.equal(r.kept.length, 1);
  assert.match(r.kept[0].refuter_note, /refuter disagrees: not reachable/);
});

test('rules: the nit budget cuts nits only', () => {
  const far = (i, severity) => checkCitation({ id: `standards#${i}`, lens: 'standards', severity, file: 'new/name.ts', line: 1, quote: 'export const a = 2;', problem: `p${i}`, fix: 'f' }, { files, headText: () => Array(400).fill('export const a = 2;').join('\n') });
  const spread = (i, severity) => ({ ...far(i, severity), line: 1 + i * 10, in_diff: true });
  const nits = Array.from({ length: MAX_NITS + 3 }, (_, i) => spread(i, 'nit'));
  const r = applyRules({ findings: [...nits, spread(20, 'bug'), spread(21, 'risk'), spread(22, 'q')] });
  assert.equal(r.dropped.nit_budget, 3);
  assert.deepEqual(r.kept.map((f) => f.severity).filter((s) => s !== 'nit').sort(), ['bug', 'q', 'risk']);
  assert.equal(r.kept[0].severity, 'bug', 'most severe first');
  const sec = { ...spread(30, 'nit'), lens: 'security' };
  assert.equal(applyRules({ findings: [...nits, sec], maxNits: 0 }).kept.length, 1, 'a security nit survives a zero budget');
});

test('rules: outside-diff findings are kept apart', () => {
  const r = applyRules({ findings: [ok(), ok({ id: 'correctness#1', line: 16, quote: 'export const far = 1;' })] });
  assert.deepEqual([r.kept.length, r.outside_diff.length], [1, 1]);
});

test('verdict: every row, and partial beside each', () => {
  const f = (severity, extra = {}) => ({ severity, lens: 'correctness', problem: 'x', ...extra });
  assert.equal(verdict({ kept: [f('bug')] }).verdict, 'blocking');
  assert.equal(verdict({ outside_diff: [f('bug')] }).verdict, 'blocking');
  assert.equal(verdict({ kept: [f('nit', { lens: 'security' })] }).verdict, 'blocking');
  assert.equal(verdict({ kept: [f('risk', { problem: 'SECURITY: token is logged.' })] }).verdict, 'blocking');
  assert.equal(verdict({ kept: [f('risk'), f('nit'), f('q')] }).verdict, 'comments');
  assert.equal(verdict({}).verdict, 'clean');
  assert.equal(verdict({}).partial, false);
  for (const kept of [[f('bug')], [f('nit')], []]) {
    const v = verdict({ kept, partial: ['lens security returned no report'] });
    assert.equal(v.partial, true);
    assert.deepEqual(v.partial_reasons, ['lens security returned no report']);
  }
  assert.deepEqual(verdict({ kept: [f('bug'), f('nit')] }).counts, { bug: 1, risk: 0, nit: 1, q: 0, security: 0 });
  // A security finding is counted once, not again under its severity.
  assert.deepEqual(verdict({ kept: [f('bug', { lens: 'security' }), f('bug')] }).counts, { bug: 1, risk: 0, nit: 0, q: 0, security: 1 });
});

test('caps: over-long fields are reported, security is exempt', () => {
  const long = 'x'.repeat(300);
  assert.deepEqual(overCaps([{ id: 'a', lens: 'correctness', problem: long, fix: 'f' }]), [{ id: 'a', field: 'problem', len: 300, cap: 240 }]);
  assert.deepEqual(overCaps([{ id: 'a', lens: 'security', problem: long }]), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'wtf-ticket-'));
process.env.WTF_STATE_DIR = join(tmp, 'wtf');
process.env.WTF_TICKET_STATE_DIR = join(tmp, 'ticket');
const T = await import('../ticket.mjs');

const repo = join(tmp, 'app');
mkdirSync(join(repo, 'src'), { recursive: true });
mkdirSync(join(repo, 'docs/plans'), { recursive: true });
writeFileSync(join(repo, 'src/void.ts'), "export function save(t) {\n  db.update(t.id, { note: t.note });\n}\n");
writeFileSync(join(repo, 'docs/plans/fix.md'), '# Plan\n');

mkdirSync(process.env.WTF_STATE_DIR, { recursive: true });
const verdict = (run, verdicts, accepted = true) =>
  appendFileSync(join(process.env.WTF_STATE_DIR, 'log.jsonl'), `${JSON.stringify({ type: 'verdict', run, verdicts, accepted, confidence: 'high' })}\n`);
const config = (c) => {
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude/wtf-and-create-ticket.json'), JSON.stringify(c));
};
const base = (run, extra = {}) => ({
  repo, run, title: 'Save drops the note', symptom: 'Note lost after save, mail a@b.co', expected: 'note kept', actual: 'note empty',
  evidence: [
    { path: 'src/void.ts', line: 2, quote: 'db.update(t.id, { note: t.note })', role: 'write_path', note: 'cc @alice' },
    { path: 'src/void.ts', line: 1, quote: 'this text is not in the file', role: 'actual' },
  ],
  fix: ['Map note in save()'], plan: '- [ ] Test save keeps note\n- [ ] Run: `npm test`', ...extra,
});

test('start asks for setup until project, tracker and destination are set', () => {
  assert.deepEqual(T.start({ repo }).needs, ['setup']);
  config({ project: 'App', tracker: 'clickup' });
  assert.match(T.start({ repo }).problems.join(), /destination\.list_id/);
  config({ project: 'App', tracker: 'clickup', destination: { list_id: '9' }, bug: { status: 'to do', priority: 'high' }, feature: { priority: 'low' } });
  assert.equal(T.start({ repo }).ok, true);
  assert.equal(T.start({ repo }).confirm, 'auto');
});

test('gate files only accepted DEFECT and FEATURE_REQUEST', () => {
  verdict('wtf-20261022-1000-000a', ['KNOWN']);
  verdict('wtf-20261022-1000-000b', ['DEFECT'], false);
  verdict('wtf-20261022-1000-000c', ['USER_ERROR', 'DEFECT']);
  assert.match(T.gate('wtf-20261022-1000-0000').reason, /no \/wtf verdict/);
  assert.match(T.gate('wtf-20261022-1000-000a').reason, /existing ticket/);
  assert.equal(T.gate('wtf-20261022-1000-000b').file, false);
  assert.equal(T.gate('wtf-20261022-1000-000c').kind, 'bug');
});

test('draft drops bad citations, scrubs report text, records once', () => {
  const run = 'wtf-20261022-1100-0001';
  verdict(run, ['DEFECT']);
  const d = T.draft(base(run, { outage: true }));
  assert.equal(d.file, true);
  assert.deepEqual(d.citations, { verified: 1, dropped: 1 });
  assert.equal(d.fields.priority, 'urgent');
  assert.equal(d.fields.title, 'Outage: Save drops the note');
  const body = readFileSync(d.body_file, 'utf8');
  assert.match(body, /`src\/void\.ts:2` \(write_path\): cc @ alice/);
  assert.match(body, /\[email\]/);
  assert.doesNotMatch(body, /a@b\.co/);
  assert.equal(T.record({ run, id: '86abc', url: 'https://app.clickup.com/t/86abc' }).ok, true);
  assert.equal(T.draft(base(run)).ticket.id, '86abc');
  assert.equal(T.record({ run, id: 'x' }).ok, false);
});

test('draft needs a fix and a plan for a bug, caps the inline plan, attaches files', () => {
  const run = 'wtf-20261022-1200-0002';
  verdict(run, ['DEFECT']);
  assert.deepEqual(T.draft(base(run, { fix: [], plan: '' })).missing, ['fix', 'plan or plan_path']);
  assert.match(T.draft(base(run, { plan: Array(20).fill('- step').join('\n') })).missing[0], /over 15 lines/);
  assert.match(T.draft(base(run, { plan_path: '../outside.md' })).missing[0], /not a file inside the repo/);
  const d = T.draft(base(run, { plan: '', plan_path: 'docs/plans/fix.md' }));
  assert.deepEqual(d.attach, [join(repo, 'docs/plans/fix.md')]);
  assert.match(readFileSync(d.body_file, 'utf8'), /`docs\/plans\/fix\.md` \(attached\)/);
});

test('a feature is always asked and takes its own defaults', () => {
  const run = 'wtf-20261022-1300-0003';
  verdict(run, ['FEATURE_REQUEST']);
  const d = T.draft(base(run, { fix: [], plan: '' }));
  assert.equal(d.kind, 'feature');
  assert.equal(d.confirm, 'ask');
  assert.equal(d.fields.priority, 'low');
  assert.equal(d.fields.status, 'to do');
});

test('run ids that are not /wtf runs are refused', () => {
  assert.throws(() => T.draft(base('../../etc')), /unknown \/wtf run/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPS, checkCaps, proseLength } from '../lib/caps.mjs';

const base = (o = {}) => ({ role: 'worker', item: '#1', loop: 1, verdict: 'pass', summary: 'ok', findings: [], files_touched: [], commits: [], ...o });
const wrap = (r, prose = '') => `${prose}\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\``;
const long = (n) => 'x'.repeat(n);

test('short report passes', () => {
  const r = base();
  assert.deepEqual(checkCaps(wrap(r), r), { ok: true, over: [] });
});

test('summary, finding text and plan fields are capped, with the field named', () => {
  const r = base({
    role: 'investigator',
    summary: long(CAPS.summary + 1),
    findings: [{ severity: 'bug', blocking: true, owner_role: 'worker', text: long(CAPS.finding + 1) }],
    plan: { summary: long(CAPS.plan_summary + 1), risks: ['fine', long(CAPS.plan_item + 1)] },
  });
  const { ok, over } = checkCaps(wrap(r), r);
  assert.equal(ok, false);
  assert.deepEqual(over.map((o) => o.field), ['summary', 'findings[0].text', 'plan.summary', 'plan.risks[1]']);
  assert.deepEqual(over[0], { field: 'summary', len: CAPS.summary + 1, cap: CAPS.summary });
});

test('prose above the block counts; JSON-only is zero', () => {
  const r = base();
  assert.equal(proseLength(wrap(r)), 0);
  assert.equal(checkCaps(wrap(r, long(CAPS.prose + 1)), r).over[0].field, 'text outside the json block');
  assert.equal(checkCaps(wrap(r, 'Done.'), r).ok, true);
});

test('security is never capped: security-advisor reports and SECURITY: findings', () => {
  const sec = base({ role: 'security-advisor', summary: long(5000), findings: [{ severity: 'bug', blocking: true, owner_role: 'worker', text: long(5000) }] });
  assert.equal(checkCaps(wrap(sec, long(5000)), sec).ok, true);
  const aud = base({ role: 'auditor', findings: [{ severity: 'risk', blocking: true, owner_role: 'worker', text: `SECURITY: ${long(2000)}` }] });
  assert.equal(checkCaps(wrap(aud), aud).ok, true);
});

test("the architect's plan.summary is the contract and is not capped", () => {
  const r = base({ role: 'architect', plan: { summary: long(5000) } });
  assert.equal(checkCaps(wrap(r), r).ok, true);
});

// changelog, quick-ask-me, wtf, review-prs, qa-this, check-infra-and-migrations and improve-design are self-contained (an agent may install one
// skill folder on its own), so they carry copies of the Jev client, the
// redaction library and the report-style rule. The copies must not drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/paths.mjs';

const SKILLS = ['changelog', 'quick-ask-me', 'wtf', 'review-prs', 'qa-this', 'check-infra-and-migrations', 'improve-design'];
const same = (source, copies) => {
  const want = readFileSync(join(ROOT, source), 'utf8');
  for (const c of copies) {
    assert.ok(existsSync(join(ROOT, c)), `${c} is missing`);
    assert.equal(readFileSync(join(ROOT, c), 'utf8'), want, `${c} differs from ${source}: copy the source over it`);
  }
};

test('Jev client copies are identical', () => same('skills/do-shit/scripts/lib/jev.mjs', SKILLS.map((s) => `skills/${s}/scripts/lib/jev.mjs`)));
test('redaction library copies are identical', () => same('hooks/lib/redact.jq', SKILLS.map((s) => `skills/${s}/scripts/lib/redact.jq`)));
test('report-style rule copies are identical', () => same('skills/do-shit/references/report-style.md', SKILLS.map((s) => `skills/${s}/references/report-style.md`)));

test('each copy redacts through its own folder', async () => {
  for (const s of SKILLS) {
    const { REDACT_LIB } = await import(join(ROOT, `skills/${s}/scripts/lib/paths.mjs`));
    assert.ok(existsSync(join(REDACT_LIB, 'redact.jq')), `${s}: ${REDACT_LIB}/redact.jq`);
    const { redactBody } = await import(join(ROOT, `skills/${s}/scripts/lib/jev.mjs`));
    const token = `ghp_${'a'.repeat(36)}`;
    assert.ok(!JSON.stringify(redactBody({ state: { body: `token ${token}` } })).includes(token), `${s}: token redacted`);
  }
});

// Local calibration: one reader, copied into every skill that asks Jev and
// into /calibrate itself.
const CALIBRATED_SKILLS = ['do-shit', 'changelog', 'quick-ask-me', 'ask-and-create-specs', 'wtf', 'review-prs', 'qa-this', 'check-infra-and-migrations', 'improve-design'];
test('calibration library copies are identical', () =>
  same('skills/calibrate/scripts/lib/calibration.mjs', CALIBRATED_SKILLS.map((s) => `skills/${s}/scripts/lib/calibration.mjs`)));

test("/calibrate's question list is exactly what the skills ship uncalibrated", async () => {
  const sets = {
    'do-shit': (await import(join(ROOT, 'skills/do-shit/scripts/lib/questions.mjs'))).UNCALIBRATED,
    changelog: (await import(join(ROOT, 'skills/changelog/scripts/judge.mjs'))).UNCALIBRATED,
    'quick-ask-me': (await import(join(ROOT, 'skills/quick-ask-me/scripts/gate.mjs'))).UNCALIBRATED,
    'ask-and-create-specs': (await import(join(ROOT, 'skills/ask-and-create-specs/scripts/spec-jev.mjs'))).UNCALIBRATED,
    wtf: (await import(join(ROOT, 'skills/wtf/scripts/lib/questions.mjs'))).UNCALIBRATED,
    'review-prs': (await import(join(ROOT, 'skills/review-prs/scripts/lib/questions.mjs'))).UNCALIBRATED,
    'qa-this': (await import(join(ROOT, 'skills/qa-this/scripts/lib/questions.mjs'))).UNCALIBRATED,
    'check-infra-and-migrations': (await import(join(ROOT, 'skills/check-infra-and-migrations/scripts/lib/questions.mjs'))).UNCALIBRATED,
    'improve-design': (await import(join(ROOT, 'skills/improve-design/scripts/lib/questions.mjs'))).UNCALIBRATED,
  };
  const shipped = Object.entries(sets).flatMap(([skill, set]) => [...set].map((q) => `${skill}/${q}`)).sort();
  const { CATALOG } = await import(join(ROOT, 'skills/calibrate/scripts/lib/catalog.mjs'));
  assert.deepEqual([...CATALOG].sort(), shipped);
  assert.equal(shipped.length, 43);
});

test('review-prs, qa-this, check-infra-and-migrations and improve-design carry the same glob matcher as do-shit', () =>
  same('skills/do-shit/scripts/lib/glob.mjs', ['skills/review-prs/scripts/lib/glob.mjs', 'skills/qa-this/scripts/lib/glob.mjs', 'skills/check-infra-and-migrations/scripts/lib/glob.mjs', 'skills/improve-design/scripts/lib/glob.mjs']));

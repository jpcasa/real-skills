// changelog, quick-ask-me and wtf are self-contained (an agent may install one
// skill folder on its own), so they carry copies of the Jev client, the
// redaction library and the report-style rule. The copies must not drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/paths.mjs';

const SKILLS = ['changelog', 'quick-ask-me', 'wtf'];
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

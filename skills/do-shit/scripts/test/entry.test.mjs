// Every script runs its CLI only when it is the entry file. That check must
// hold for an install path with a space in it and for a symlinked install: a
// guard that is wrongly false prints nothing and exits 0, and the agent, told
// to parse one JSON object from stdout, reads that as an empty success.
// Covers every script under skills/*/scripts that reads process.argv[1], so a
// new skill's script is picked up without a change here.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/paths.mjs';

const SKILLS = join(ROOT, 'skills');
const OLD_GUARD = 'file://${process.argv[1]}';
const mjs = (dir) => readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.mjs') && !f.includes('node_modules')).sort();
const scripts = mjs(SKILLS).filter((f) => /^[^/]+\/scripts\//.test(f) && !f.includes('/test/'));
const guarded = scripts.filter((f) => readFileSync(join(SKILLS, f), 'utf8').includes('process.argv[1]'));

// Default: an unknown command prints one {error} object and exits non-zero.
const SPECIAL = {
  // No commands: reads one JSON object from stdin.
  'changelog/scripts/judge.mjs': { args: [], input: 'not json' },
  // Not a JSON CLI: writes references/rules.md and prints its path.
  'check-infra-and-migrations/scripts/gen-rules-doc.mjs': { args: [], ok: true, json: false },
  // No commands: scores eval/fixtures, which do not ship. An empty folder gives an empty report.
  'do-shit/scripts/eval/run.mjs': { args: [], ok: true, setup: (dir) => mkdirSync(join(dir, 'fixtures')) },
};

const base = mkdtempSync(join(tmpdir(), 'entry guard '));
after(() => rmSync(base, { recursive: true, force: true }));
// The whole tree: ask-and-create-specs loads its Jev client from do-shit.
cpSync(SKILLS, join(base, 'skills'), { recursive: true });
symlinkSync(join(base, 'skills'), join(base, 'linked'));
for (const [f, c] of Object.entries(SPECIAL)) c.setup?.(join(base, 'skills', dirname(f)));
const importer = join(base, 'importer.mjs');
writeFileSync(importer, 'await import(process.env.ENTRY_URL);\n');

const node = (args, { input = '', env = {} } = {}) =>
  spawnSync(process.execPath, args, { input, encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: base, ...env } });

test('there are scripts to check', () => assert.ok(guarded.length >= 10, `found ${guarded.length}`));

test('no script compares import.meta.url with a file:// string', () => {
  const files = [...scripts.map((f) => join(SKILLS, f)), ...mjs(join(ROOT, 'hooks')).map((f) => join(ROOT, 'hooks', f))];
  const old = files.filter((f) => readFileSync(f, 'utf8').includes(OLD_GUARD));
  assert.deepEqual(old, [], 'use the realpath comparison (see any harness script)');
});

for (const f of guarded) {
  const { args = ['no-such-command'], input = '', ok = false, json = true } = SPECIAL[f] || {};
  for (const [how, dir] of [['a path with a space', 'skills'], ['a symlink', 'linked']]) {
    test(`${f} runs its CLI from ${how}`, () => {
      const r = node([join(base, dir, f), ...args], { input });
      if (ok) assert.equal(r.status, 0, r.stderr);
      else assert.ok(r.status > 0, `exit ${r.status}, stdout ${JSON.stringify(r.stdout)}`);
      if (!json) return assert.match(r.stdout, /\S/);
      // All of stdout is one JSON object (spec-jev.mjs prints it over several lines).
      const o = JSON.parse(r.stdout);
      assert.ok(o && typeof o === 'object' && !Array.isArray(o), `one JSON object on stdout, got ${JSON.stringify(r.stdout)}`);
      if (!ok) assert.equal(typeof o.error, 'string');
    });
  }

  test(`${f} stays quiet when imported`, () => {
    const env = { ENTRY_URL: pathToFileURL(join(base, 'skills', f)).href };
    // From another entry file, and with no entry file at all (process.argv[1] undefined).
    for (const r of [node([importer], { env }), node(['--input-type=module', '-e', 'await import(process.env.ENTRY_URL)'], { env })]) {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '');
    }
  });
}

// /promote does not classify migrations or infrastructure itself: that is
// /check-infra-and-migrations, the skill next to this one. This file calls its
// harness as a separate process and reads what it printed. The verdict is read
// from there, never taken from the agent.
//
// Installed as a single folder there is no sibling: every call then answers
// { ok: false, reason }, and the gate is `unknown`.
// PROMOTE_CHECK_HARNESS points somewhere else (tests).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './paths.mjs';

export const harness = () => process.env.PROMOTE_CHECK_HARNESS || join(SKILL_DIR, '../check-infra-and-migrations/scripts/check.mjs');
export const SIBLING = 'check-infra-and-migrations';

function call(args, input) {
  if (!existsSync(harness())) return { ok: false, reason: `${SIBLING} is not installed next to this skill` };
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [harness(), ...args], { input: input === undefined ? '' : JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'], timeout: 180_000, maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch (e) {
    stdout = String(e.stdout || '');
    if (!stdout.trim()) return { ok: false, reason: `${SIBLING} did not answer (${String(e.stderr || e.message).trim().split('\n')[0]})` };
  }
  let json;
  try {
    json = JSON.parse(stdout.trim().split('\n').pop());
  } catch {
    return { ok: false, reason: `${SIBLING} printed something that is not JSON` };
  }
  if (json.error) return { ok: false, reason: /unknown command/.test(json.error) ? `the installed ${SIBLING} is too old to be read from here (no \`verdict\` command)` : `${SIBLING}: ${json.error}` };
  return { ok: true, json };
}

// Starts a check of base..head for an environment. Never posts.
// -> { ok, run_id, target, bucketed, buckets, counts, live } | { ok: false, reason }
export function checkStart(repo, baseRef, headRef, env) {
  const r = call(['start'], { repo, args: [`${baseRef}..${headRef}`, '--target', env, '--no-post'] });
  if (!r.ok) return r;
  const t = r.json.targets?.[0];
  if (!r.json.run_id || !t) return { ok: false, reason: `${SIBLING} started no run for ${baseRef}..${headRef}` };
  return { ok: true, run_id: r.json.run_id, target: t.id, bucketed: t.bucketed, buckets: t.buckets, counts: t.counts, live: Boolean(r.json.ask?.live), layout_from: r.json.layout_from || null };
}

// What that run recorded. -> { ok, targets: [{ id, base_sha, head_sha, verdict, ... }] } | { ok: false, reason }
export function checkVerdict(runId) {
  if (!/^cim-\d{8}-\d{4}-[0-9a-f]{4}$/.test(String(runId))) return { ok: false, reason: `${JSON.stringify(runId)} is not a ${SIBLING} run id` };
  const r = call(['verdict', '--run', String(runId)]);
  return r.ok ? { ok: true, targets: r.json.targets || [] } : r;
}

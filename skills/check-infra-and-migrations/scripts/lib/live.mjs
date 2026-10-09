// The three optional reads against a real environment: which migrations it has
// applied, how big its tables are, and what an infrastructure plan would do.
// Each is the user's own shell string from the config. This file runs it,
// keeps the output in the run folder and derives facts from it. It cannot see
// inside the command: read-only credentials are the real boundary.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { STATEFUL_TYPE } from './infra.mjs';

export const LIVE_KINDS = ['applied', 'sizes', 'plan'];
export const TIMEOUT_S = { applied: 120, sizes: 120, plan: 900 };
// A guard against a paste mistake, not a sandbox: a live command reads. Words
// are matched alone, after a colon (`db:migrate`) and before one or a dash
// (`migrate:latest`, `delete-db-instance`), also inside a quoted SQL string.
const WRITES = /(^|[\s;&|(:"'])(deploy|apply|push|migrate|up|destroy|upgrade|import|drop|delete|truncate|reset|insert|update|alter)(?=$|[\s;&|):"'-])/i;

// Why this command string may not be configured, or null.
export function commandRefusal(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return 'must be a non-empty command string';
  const m = cmd.match(WRITES);
  if (m) return `contains "${m[2]}": a live command only reads (use the tool's diff, plan or list form)`;
  return null;
}

// -> { ok, exit, timeout, output }
export function runCommand(repo, cmd, kind) {
  try {
    const output = execFileSync('sh', ['-c', cmd], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], timeout: TIMEOUT_S[kind] * 1000, maxBuffer: 64 * 1024 * 1024 }).toString();
    return { ok: true, exit: 0, timeout: false, output };
  } catch (e) {
    return { ok: false, exit: typeof e.status === 'number' ? e.status : 1, timeout: e.code === 'ETIMEDOUT' || e.killed === true, output: `${e.stdout || ''}${e.stderr || ''}` || String(e.message) };
  }
}

const cells = (line) => line.split(/[\t|,]/).map((c) => c.trim().replace(/^["']|["']$/g, '')).filter(Boolean);

// One applied migration per line: a name, a version or a content hash.
export const parseApplied = (output) => new Set(String(output).split('\n').flatMap(cells));

// How a migration file can be named in a migrations table.
// A short name or number can turn up in any column of the output (an id, a
// count), so only a name of six characters or a version of four digits counts.
function candidates(m) {
  const base = m.name;
  const stem = base.replace(/\.[^.]+$/, '');
  const out = { name: [base, m.file, ...(stem.length >= 6 ? [stem] : [])] };
  const prefix = stem.match(/^\d+/)?.[0];
  if (prefix && prefix.length >= 4) out.version = [prefix];
  if (typeof m.content === 'string') out.hash = [createHash('sha256').update(m.content).digest('hex')];
  return out;
}
const LOOKS = { hash: /^[0-9a-f]{64}$/, version: /^\d+$/, name: /./ };

// migrations: [{ file, name, content }]   name: the file or folder name the tool orders by.
// -> { applied: [file], pending: [file], by, ahead, no_match }
export function matchApplied(tokens, migrations) {
  const applied = [];
  const pending = [];
  const used = new Set();
  const kinds = {};
  for (const m of migrations) {
    const c = candidates(m);
    const kind = Object.keys(c).find((k) => c[k].some((v) => tokens.has(v)));
    if (!kind) {
      pending.push(m.file);
      continue;
    }
    applied.push(m.file);
    kinds[kind] = (kinds[kind] || 0) + 1;
    for (const v of c[kind]) if (tokens.has(v)) used.add(v);
  }
  const by = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  // Tokens of the same shape that no file accounts for: the target ran something this tree lacks.
  const ahead = by ? [...tokens].filter((t) => !used.has(t) && LOOKS[by].test(t) && (by !== 'name' || /\d/.test(t))).length : 0;
  return { applied, pending, by, ahead, no_match: tokens.size > 0 && migrations.length > 0 && !applied.length };
}

// table<TAB>rows per line -> Map(table -> rows). The schema and quotes are dropped.
// A negative count is Postgres saying "never analyzed": kept as -1, unknown.
export function parseSizes(output) {
  const sizes = new Map();
  for (const line of String(output).split('\n')) {
    const c = cells(line.includes('\t') || line.includes('|') || line.includes(',') ? line : line.trim().replace(/\s+/g, '\t'));
    if (c.length < 2 || !/^-?\d+$/.test(c[c.length - 1])) continue;
    const table = c[0].split('.').pop().replace(/["`]/g, '').toLowerCase();
    const rows = Number(c[c.length - 1]);
    // The same name in two schemas: the larger one is the one that matters.
    sizes.set(table, sizes.has(table) ? Math.max(rows, sizes.get(table)) : rows);
  }
  return sizes;
}

const CDK_LINE = /^\[([+~-])\]\s+(\w+::\w+::\w+)\s+(\S+)(.*)$/;
const TF_LINE = /^\s*#\s+(\S+)\s+(?:will be (created|destroyed|updated in-place)|(?:is tainted, so )?must be (replaced))/;
const tfType = (address) => {
  const segs = address.replace(/\[[^\]]*\]/g, '').split('.');
  return { type: segs[segs.length - 2] || address, name: segs[segs.length - 1] };
};

// `cdk diff` or `terraform plan` output -> { tool, counts, resources: [{action, type, name}] }
// tool is null when the output is neither: it was read by nobody.
export function parsePlan(text) {
  const clean = String(text).replace(/\x1b\[[0-9;]*m/g, '');
  const resources = [];
  let tool = null;
  let cur = null;
  for (const raw of clean.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const cdk = line.match(CDK_LINE);
    if (cdk) {
      tool = 'cdk';
      const rest = cdk[4];
      const action = cdk[1] === '+' ? 'create' : cdk[1] === '-' ? (/\borphan/.test(rest) ? 'orphan' : 'destroy') : /\breplace/.test(rest) ? 'replace' : 'update';
      cur = { action, type: cdk[2], name: cdk[3] };
      resources.push(cur);
      continue;
    }
    // A property of the resource above that forces a new one.
    if (cur && tool === 'cdk' && /^\s+\S/.test(line) && /\breplace(ment)?\b/i.test(line) && cur.action === 'update') cur.action = 'replace';
    const tf = line.match(TF_LINE);
    if (tf) {
      tool = 'terraform';
      const what = tf[2] || tf[3];
      resources.push({ action: what === 'created' ? 'create' : what === 'destroyed' ? 'destroy' : what === 'replaced' ? 'replace' : 'update', ...tfType(tf[1]) });
    }
  }
  if (!tool && /^Plan: \d+ to add|^No changes\.|Terraform will perform/m.test(clean)) tool = 'terraform';
  if (!tool && /There were no differences|^Stack \S+|Number of stacks with differences/m.test(clean)) tool = 'cdk';
  const counts = { create: 0, update: 0, destroy: 0, replace: 0, orphan: 0 };
  for (const r of resources) counts[r.action] += 1;
  return { tool, counts, resources };
}

// What a plan's destroys and replaces mean. No file: the plan is the evidence.
export function planFindings(plan) {
  return plan.resources.filter((r) => r.action === 'destroy' || r.action === 'replace').map((r) => {
    const stateful = STATEFUL_TYPE.test(r.type);
    const rule = `plan_${r.action === 'destroy' ? 'destroys' : 'replaces'}_${stateful ? 'stateful' : 'resource'}`;
    return { source: 'live', bucket: 'infra', origin: 'plan', rule, file: null, line: null, resource: { type: r.type, name: r.name }, normalized: `plan: ${r.action} ${r.type} ${r.name}` };
  });
}

// Runs the checks a script can run: test commands, read-only queries and HTTP
// requests. The model proposes a check; what happened is recorded here, from
// the exit code, the row count or the response status. Output and row values
// go to files in the run folder and nowhere else.

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { envRefusal, findEnv, hostOf } from './env.mjs';
import { checkSelect } from './sql.mjs';
import { safeId } from './items.mjs';
import * as S from './state.mjs';

export const VERBS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const READ_VERBS = ['GET', 'HEAD'];
// A check never carries a credential: a request that needs one is not one this skill makes.
const CREDENTIAL_HEADER = /authorization|cookie|token|secret|api[-_]?key|password|session/i;
export const EXPECT_KEYS = ['rows_eq', 'rows_gte', 'rows_lte', 'cell_eq'];

// A repo-relative path that stays inside the repo.
export const insideRepo = (p) => typeof p === 'string' && p !== '' && !isAbsolute(p) && !normalize(p).startsWith('..') && !p.includes('\0');

// Why this request may not be made, or null.
export function requestRefusal(request, env, dataChanges) {
  const method = String(request?.method || 'GET').toUpperCase();
  if (!VERBS.includes(method)) return `unknown HTTP method ${method}`;
  const path = String(request?.path || '');
  if (!path.startsWith('/') || path.startsWith('//')) return 'request.path must be a path on the environment, starting with one /';
  const bad = Object.keys(request?.headers || {}).find((h) => CREDENTIAL_HEADER.test(h));
  if (bad) return `header ${bad} looks like a credential: checks never carry one`;
  if (!READ_VERBS.includes(method) && env?.kind !== 'local' && !dataChanges) return `${method} changes data: on ${env?.kind || 'this environment'} it runs only after the user accepted data changes`;
  return null;
}

const outFile = (run, item, check, ext) => join(S.sub(run.run_id, 'out'), `${safeId(item.id)}--${safeId(check.id)}.${ext}`);
const tailOf = (text, lines = 200) => String(text).split('\n').slice(-lines).join('\n');

// A test runner started from inside another one must report for itself.
const childEnv = () => {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  return env;
};

function runCommand(run, config, item, check) {
  const tests = config.tests || {};
  const command = tests[check.suite];
  if (!command) return { result: 'skipped', evidence: { kind: 'command', reason: `no tests.${check.suite} command configured` } };
  const files = check.files || [];
  const gone = files.find((f) => !insideRepo(f) || !existsSync(join(run.repo, f)));
  if (gone) return { result: check.method === 'new_tests' ? 'fail' : 'skipped', evidence: { kind: 'command', reason: `test file not found: ${gone}` } };
  const log = outFile(run, item, check, 'log');
  const started = Date.now();
  let exit = 0;
  let output = '';
  let timeout = false;
  try {
    // The configured command is the user's own string. File names are passed
    // as arguments, never spliced into it.
    output = execFileSync('sh', ['-c', `${command} "$@"`, 'sh', ...files], {
      cwd: run.repo, stdio: ['ignore', 'pipe', 'pipe'], timeout: (Number(tests.timeout_s) || 600) * 1000, maxBuffer: 64 * 1024 * 1024, env: childEnv(),
    }).toString();
  } catch (e) {
    exit = typeof e.status === 'number' ? e.status : 1;
    timeout = e.code === 'ETIMEDOUT' || e.killed === true;
    output = `${e.stdout || ''}${e.stderr || ''}` || String(e.message);
  }
  writeFileSync(log, tailOf(output));
  return {
    result: exit === 0 ? 'pass' : 'fail',
    evidence: { kind: 'command', command: [command, ...files].join(' '), exit, ...(timeout ? { timeout: true } : {}), duration_ms: Date.now() - started, log },
  };
}

function runQuery(run, config, item, check) {
  const refusal = envRefusal(config, run.env);
  if (refusal) return { result: 'skipped', evidence: { kind: 'query', reason: refusal } };
  const db = (config.databases || []).find((d) => d && d.env === run.env && d.how);
  if (!db) return { result: 'skipped', evidence: { kind: 'query', reason: `no databases entry for environment ${run.env}` } };
  const checked = checkSelect(check.sql);
  if (!checked.ok) return { result: 'skipped', evidence: { kind: 'query', reason: `refused: ${checked.reason}` } };
  const started = Date.now();
  let output = '';
  try {
    output = execFileSync('sh', ['-c', db.how], { cwd: run.repo, input: checked.sql, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 16 * 1024 * 1024 }).toString();
  } catch (e) {
    writeFileSync(outFile(run, item, check, 'log'), tailOf(`${e.stdout || ''}${e.stderr || ''}` || String(e.message)));
    return { result: 'fail', evidence: { kind: 'query', exit: typeof e.status === 'number' ? e.status : 1, duration_ms: Date.now() - started } };
  }
  // Row values stay in this file.
  writeFileSync(outFile(run, item, check, 'rows'), output);
  const lines = output.split('\n').filter((l) => l.trim() !== '');
  const cells = (line) => String(line ?? '').split(/\t|\|/).map((c) => c.trim());
  const columns = db.header ? cells(lines[0]).slice(0, 30) : null;
  const data = db.header ? lines.slice(1) : lines;
  const rows = data.length;
  const want = check.expect || {};
  const ok =
    (want.rows_eq === undefined || rows === Number(want.rows_eq)) &&
    (want.rows_gte === undefined || rows >= Number(want.rows_gte)) &&
    (want.rows_lte === undefined || rows <= Number(want.rows_lte)) &&
    (want.cell_eq === undefined || (rows > 0 && cells(data[0])[0] === String(want.cell_eq)));
  return { result: ok ? 'pass' : 'fail', evidence: { kind: 'query', rows, ...(columns ? { columns } : {}), exit: 0, duration_ms: Date.now() - started } };
}

async function runRequest(run, config, item, check) {
  const refusal = envRefusal(config, run.env);
  if (refusal) return { result: 'skipped', evidence: { kind: 'http', reason: refusal } };
  const env = findEnv(config, run.env);
  const no = requestRefusal(check.request, env, run.data_changes === true);
  if (no) return { result: 'skipped', evidence: { kind: 'http', reason: no } };
  const method = String(check.request.method || 'GET').toUpperCase();
  const url = new URL(check.request.path, env.base_url);
  if (hostOf(url.href) !== hostOf(env.base_url)) return { result: 'skipped', evidence: { kind: 'http', reason: 'the request left the environment host' } };
  const started = Date.now();
  const evidence = { kind: 'http', method, path: url.pathname };
  try {
    const body = check.request.body === undefined ? undefined : typeof check.request.body === 'string' ? check.request.body : JSON.stringify(check.request.body);
    // Redirects are not followed: one could lead off the environment.
    const res = await fetch(url, {
      method, redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { ...(body !== undefined && typeof check.request.body !== 'string' ? { 'content-type': 'application/json' } : {}), ...(check.request.headers || {}) },
      ...(body !== undefined && !READ_VERBS.includes(method) ? { body } : {}),
    });
    const text = method === 'HEAD' ? '' : await res.text();
    writeFileSync(outFile(run, item, check, 'body'), text.slice(0, 200000));
    const want = check.expect || {};
    const statuses = want.status === undefined ? null : [].concat(want.status).map(Number);
    const ok = (statuses ? statuses.includes(res.status) : res.status < 400) && (want.body_includes === undefined || text.includes(String(want.body_includes)));
    return { result: ok ? 'pass' : 'fail', evidence: { ...evidence, status: res.status, duration_ms: Date.now() - started } };
  } catch (e) {
    return { result: 'fail', evidence: { ...evidence, error: e.name === 'TimeoutError' ? 'timeout' : 'no response', duration_ms: Date.now() - started } };
  }
}

export const RUNNABLE = ['checks', 'new_tests', 'database', 'api'];
export async function execute(run, config, item, check) {
  if (check.method === 'checks' || check.method === 'new_tests') return runCommand(run, config, item, check);
  if (check.method === 'database') return runQuery(run, config, item, check);
  if (check.method === 'api') return runRequest(run, config, item, check);
  throw new Error(`check ${check.id} uses ${check.method}, which this command does not run`);
}

// What a failed check looked like, in a few words, from its evidence.
export function signal(check) {
  const e = check.evidence || {};
  if (e.kind === 'command') return e.timeout ? 'timeout' : e.reason || `exit ${e.exit}`;
  if (e.kind === 'query') return e.reason || (e.exit ? `query failed, exit ${e.exit}` : `${e.rows} rows`);
  if (e.kind === 'http') return e.reason || (e.error ? e.error : `http ${e.status}`);
  return String(e.actual || e.note || e.reason || '');
}

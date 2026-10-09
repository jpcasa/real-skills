// Which QA methods run for an item. Code rules choose; the model proposes
// checks, and a check for a method that was not chosen is set aside, not run.
// The user (the plan question, --method) and, once calibrated, Jev can add a
// method. Nothing here ever removes one that a rule chose.

import { anyMatch } from './glob.mjs';
import { envRefusal } from './env.mjs';

export const METHODS = ['checks', 'browser', 'database', 'api', 'new_tests', 'runtime'];
// Methods that touch a running environment.
export const ENV_METHODS = ['browser', 'database', 'api'];

const UI = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html|astro)$|(^|\/)(components|pages|views|screens|ui|layouts)\//i;
const DATA = /\.(sql|prisma)$|(^|\/)(migrations?|schema|schemas|prisma|drizzle|supabase|db|database|models?|repositories)\//i;
const API = /(^|\/)(api|routes?|handlers?|controllers?|server|trpc|graphql|functions|webhooks?)\//i;
const TEST = /(\.|\/)(test|spec)\.[a-z]+$|(^|\/)(__tests__|e2e|tests?)\//i;

const safeRe = (src) => {
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
};

// session: { browser: bool } — whether this session can drive a browser.
// -> { method: { ok, reason } }
export function available(config, session = {}, envName = null) {
  const tests = config.tests || {};
  const runner = Boolean(tests.unit || tests.e2e);
  const refusal = envRefusal(config, envName);
  const env = refusal ? { ok: false, reason: refusal } : { ok: true };
  const db = (config.databases || []).some((d) => d && d.env === envName && d.how);
  const no = (reason) => ({ ok: false, reason });
  return {
    checks: runner ? { ok: true } : no('no test command configured (tests.unit or tests.e2e)'),
    browser: !env.ok ? env : session.browser ? { ok: true } : no('this session has no browser to drive'),
    database: !env.ok ? env : db ? { ok: true } : no(`no databases entry for environment ${envName}`),
    api: env,
    new_tests: !runner ? no('no test command configured') : tests.globs?.length ? { ok: true } : no('tests.globs is not set: nowhere a new test is allowed to go'),
    runtime: Object.keys(config.runtime || {}).length ? { ok: true } : no('no runtime sources configured'),
  };
}

// item: { changed_files, criteria: [{id, user_visible?}], checks: [{criterion, method}] }
// extra: methods added by --method, the user, or a calibrated Jev answer.
// -> [{ method, why }]
export function choose(item, config, extra = []) {
  const files = (item.changed_files || []).filter((f) => !TEST.test(f));
  const picked = new Map();
  const add = (method, why) => {
    if (METHODS.includes(method) && !picked.has(method)) picked.set(method, why);
  };
  const tests = config.tests || {};
  if (tests.unit || tests.e2e) add('checks', 'a test command is configured');
  const ui = files.find((f) => UI.test(f));
  if (ui) add('browser', `changed UI file ${ui}`);
  else if ((item.criteria || []).some((c) => c.user_visible)) add('browser', 'a criterion is something a user sees');
  const data = files.find((f) => DATA.test(f));
  if (data) add('database', `changed data-layer file ${data}`);
  const api = files.find((f) => API.test(f));
  if (api && !picked.has('browser')) add('api', `changed ${api} and no UI change covers it`);
  for (const rule of config.path_rules || []) {
    const re = safeRe(rule?.pattern);
    const hit = re && files.find((f) => re.test(f));
    if (hit) for (const m of rule.methods || []) add(m, `path rule ${rule.pattern} matches ${hit}`);
  }
  for (const e of extra) add(e.method, e.why);
  // A criterion no existing test covers gets a new one, when there is a place for it.
  const tested = new Set((item.checks || []).filter((c) => c.method === 'checks').map((c) => c.criterion));
  const untested = (item.criteria || []).filter((c) => !tested.has(c.id));
  if (tests.globs?.length && untested.length) add('new_tests', `${untested.length} criteria have no existing test`);
  if (Object.keys(config.runtime || {}).length && (picked.has('browser') || picked.has('api'))) add('runtime', 'the run exercises the app and runtime sources are configured');
  return [...picked].map(([method, why]) => ({ method, why }));
}

export const matchesGlobs = (globs, path) => anyMatch(globs || [], path);

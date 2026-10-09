// Jev questions for /promote. All three are about what the repo's pipeline
// looks like, asked once per probe, and the right answer arrives by itself:
// the stage list the user confirms at setup.
//
// Jev sees names only: branches, workflow file names, the branches each
// workflow runs on, environment names, hosting providers, and one line per
// "this branch is made of merges from that one". Never a URL, a host, a
// workflow body or an env value. Everything is scrubbed again before it leaves.

import * as C from './calibration.mjs';
import { scrub } from './scrub.mjs';

export const SKILL = 'promote';
export const THRESHOLDS = {
  branch_deploys_env: 0.6, // at or above: setup shows it as the other reading
  env_promotes_from: 0.6, // at or above: setup shows it as the other reading
  env_is_production: 0.5, // at or above: the stage is proposed as production
};
// unsafe: the error that must never happen (fn = saying no when the answer was yes).
// Calling production "not production" loses the plain warning before a merge.
export const SHAPE = {
  branch_deploys_env: { acts_when: 'gte', unsafe: null },
  env_promotes_from: { acts_when: 'gte', unsafe: null },
  env_is_production: { acts_when: 'gte', unsafe: 'fn' },
};
// No outcome data yet: logged, never deciding. PROMOTE_TEST_CALIBRATED is for tests.
export const UNCALIBRATED = new Set(Object.keys(THRESHOLDS));
const forTests = (id) => (process.env.PROMOTE_TEST_CALIBRATED || '').split(',').includes(id);
export const calibrated = (id) => !UNCALIBRATED.has(id) || forTests(id) || C.isOn(SKILL, id);
export const thr = (id) => C.threshold(SKILL, id, THRESHOLDS[id]);
export const spot = (id, caseId) => UNCALIBRATED.has(id) && !forTests(id) && C.isOn(SKILL, id) && C.spotCheck(caseId);

export const MAX_PAIRS = 12;
const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
// A name as Jev may see it: no link, no host, nothing but name characters.
// An environment name that is really a host (`app.io`) goes as a placeholder. File names keep their dot.
const envName = (s) => (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(String(s ?? '').trim()) ? '[host]' : name(s));
const name = (s) => scrub(String(s ?? '').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '').replace(/\b(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b/gi, '')).replace(/[^\w ./-]/g, '').slice(0, 60);

// p: what probe() returned. repoName: a label for the case id, never sent.
// -> { state, questions, cases: [{ question, key, case, show, branch?, env?, from? }] }
export function build(p, repoName) {
  const stages = p.stages || [];
  const state = {
    branches: (p.branches || []).map(name),
    default_branch: name(p.default_branch || ''),
    workflows: (p.workflows || []).map((w) => ({ file: name(w.file), runs_on_push_to: w.push_branches.map(name), environments: w.environments.map(envName), deploys: Boolean(w.deploys) })),
    hosting: (p.hosting || []).map(name),
    merge_history: (p.lineage || []).map((f) => `${f.merges} of the last ${f.of} merges on ${name(f.into)} came from ${name(f.from)}`),
    environments: stages.map((s) => envName(s.env)),
  };
  const questions = {};
  const cases = [];
  // Each environment against the branch proposed for it and against the others.
  const pairs = stages.flatMap((s) => [s.branch, ...(p.branches || []).filter((b) => b !== s.branch)].filter(Boolean).map((b) => ({ branch: b, env: s.env }))).slice(0, MAX_PAIRS);
  pairs.forEach((x, n) => {
    questions[`deploys__${n}`] = noul(
      `Going by \`workflows\`, \`hosting\`, \`merge_history\` and the names, does a push to the branch \`${name(x.branch)}\` deploy the environment \`${envName(x.env)}\`?`,
      'That branch is the one this environment runs: a workflow or the host deploys it on every push or merge to it.',
      'Another branch feeds this environment, or nothing ties that branch to it.',
    );
    cases.push({ question: 'branch_deploys_env', key: `deploys__${n}`, case: C.caseId(repoName, 'deploys', x.branch, x.env), show: `Does a push to ${x.branch} deploy ${x.env}?`, branch: x.branch, env: x.env });
  });
  const ordered = stages.flatMap((s) => stages.filter((f) => f !== s).map((f) => ({ env: s.env, from: f.env }))).slice(0, MAX_PAIRS);
  ordered.forEach((x, n) => {
    questions[`from__${n}`] = noul(
      `Going by \`merge_history\`, \`workflows\` and the names, does the environment \`${envName(x.env)}\` get new code by promoting what \`${envName(x.from)}\` already runs?`,
      'Code reaches it from that environment: its branch is merged or promoted into this one.',
      'Code reaches it some other way, or it is the earlier of the two.',
    );
    cases.push({ question: 'env_promotes_from', key: `from__${n}`, case: C.caseId(repoName, 'from', x.env, x.from), show: `Is ${x.env} fed by promoting ${x.from}?`, env: x.env, from: x.from });
  });
  stages.forEach((s, n) => {
    questions[`prod__${n}`] = noul(
      `Is the environment \`${envName(s.env)}\` (branch \`${name(s.branch || '')}\`) the one real users use?`,
      'It is production: the live environment customers or end users are on.',
      'It is a test, preview, staging or development environment.',
    );
    cases.push({ question: 'env_is_production', key: `prod__${n}`, case: C.caseId(repoName, 'prod', s.env, s.branch || ''), show: `Is ${s.env} (${s.branch || 'no branch'}) production?`, env: s.env });
  });
  return { state, questions, cases };
}

// The right answer for each logged case, read from the stage list the user
// confirmed. A case about an environment the user renamed or removed has no
// right answer here and gets none. `production`: (stage) => boolean.
// -> [{ question, case, label, p }]
export function labels(cases, stages, production) {
  const stage = (env) => stages.find((s) => s.env === env) || null;
  const out = [];
  for (const c of cases || []) {
    let label = null;
    if (c.question === 'branch_deploys_env' && stage(c.env)) label = stage(c.env).branch === c.branch;
    else if (c.question === 'env_promotes_from' && stage(c.env) && stage(c.from)) label = stage(c.env).from === c.from;
    else if (c.question === 'env_is_production' && stage(c.env)) label = Boolean(production(stage(c.env)));
    if (label !== null) out.push({ question: c.question, case: c.case, label, p: typeof c.p === 'number' ? c.p : null });
  }
  return out;
}

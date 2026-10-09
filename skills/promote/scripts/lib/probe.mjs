// What this repo already says about its environments: which long-lived
// branches exist, which workflows deploy on a push to which branch, which
// hosting files are there, and whether one branch is made of merges from
// another. Setup turns the result into the recommended answer, so the user
// confirms instead of typing. Reads names: branches, workflow files, their
// trigger branches and `environment:` names. Never a workflow body beyond
// those lines, never a value from an env file, never the network.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, isBranch, OWN_FILE } from './config.mjs';

// Branch names that usually mean an environment, and the name it usually has.
const ENV_OF = { production: 'production', prod: 'production', live: 'production', release: 'production', staging: 'staging', stage: 'staging', preprod: 'preprod', uat: 'uat', qa: 'qa', develop: 'development', dev: 'development' };
const TRUNKS = ['main', 'master', 'trunk'];
const RANK = { development: 0, preview: 1, staging: 2, qa: 3, uat: 4, preprod: 5, production: 9 };
const HOSTING = { 'vercel.json': 'vercel', 'netlify.toml': 'netlify', 'render.yaml': 'render', 'fly.toml': 'fly', 'wrangler.toml': 'cloudflare', 'wrangler.json': 'cloudflare', 'wrangler.jsonc': 'cloudflare', 'railway.json': 'railway', 'railway.toml': 'railway', 'app.yaml': 'gcp', 'Procfile': 'heroku', 'cdk.json': 'aws', 'serverless.yml': 'aws', 'sst.config.ts': 'aws' };
const DEPLOYS = /deploy|release|publish|ship/i;
const DEPLOY_COMMAND = /cdk\s+deploy|terraform\s+apply|sst\s+deploy|(serverless|sls)\s+deploy|vercel\s+(deploy|--prod)|netlify\s+deploy|flyctl\s+deploy|fly\s+deploy|wrangler\s+(deploy|publish)|aws\s+(ecs|deploy|s3\s+sync|lambda)|kubectl\s+apply|helm\s+upgrade|gcloud\s+(run|app)\s+deploy|docker\s+push/;
export const MAX_STAGES = 5;
const MAX_MERGES = 30;

const git = (repo, args) => {
  try {
    return execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).toString().trim();
  } catch {
    return '';
  }
};
const readText = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};
const unquote = (s) => String(s).trim().replace(/^["']|["']$/g, '').trim();
const indentOf = (l) => l.length - l.trimStart().length;

// The branches a workflow runs on for a push, and the environments it names.
// A small line reader, not a YAML parser: it understands the two ways people
// write `branches`, and treats anything else as "not known".
// -> { push: null | ['*'] | [names], environments: [], deploys }
export function readWorkflow(file, text) {
  const lines = text.split('\n').map((l) => l.replace(/\s+#.*$/, '').replace(/\r$/, ''));
  let push = null;
  const environments = [];
  // Only a `push:` directly under the top-level `on:` is a trigger: a step may have a `push: true` of its own.
  let inOn = false;
  let childIndent = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const on = l.match(/^["']?on["']?\s*:\s*(.*)$/);
    if (on) {
      inOn = !on[1].trim();
      childIndent = null;
      if (/\bpush\b/.test(on[1])) push = push || ['*'];
      continue;
    }
    if (inOn && l.trim() && indentOf(l) === 0) inOn = false;
    if (inOn && l.trim() && childIndent === null) childIndent = indentOf(l);
    const p = inOn && indentOf(l) === childIndent ? l.match(/^(\s*)push\s*:\s*(.*)$/) : null;
    if (p) {
      const base = p[1].length;
      let found = null;
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > base); j++) {
        const b = lines[j].match(/^(\s*)branches\s*:\s*(.*)$/);
        if (!b) continue;
        if (b[2].startsWith('[')) found = b[2].replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
        else {
          found = [];
          for (let k = j + 1; k < lines.length && (lines[k].trim() === '' || indentOf(lines[k]) > b[1].length || /^\s*-/.test(lines[k]) && indentOf(lines[k]) >= b[1].length); k++) {
            const item = lines[k].match(/^\s*-\s*(.+)$/);
            if (item) found.push(unquote(item[1]));
          }
        }
        break;
      }
      push = found && found.length ? found : ['*'];
    }
    const e = l.match(/^\s*environment\s*:\s*(.*)$/);
    if (e) {
      const value = e[1].trim() ? unquote(e[1]) : unquote((lines[i + 1] || '').match(/^\s*name\s*:\s*(.+)$/)?.[1] || '');
      if (value && !value.includes('${{') && /^[\w .-]{1,40}$/.test(value) && !environments.includes(value)) environments.push(value);
    }
  }
  return { file, push, environments, deploys: DEPLOYS.test(file) || DEPLOY_COMMAND.test(text) };
}

// Branch names and the ref each is read from: the remote's when there is one.
function listBranches(repo) {
  const refs = git(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes', 'refs/heads']).split('\n').filter(Boolean);
  const remotes = [...new Set(refs.filter((r) => r.startsWith('refs/remotes/')).map((r) => r.split('/')[2]))];
  const remote = remotes.includes('origin') ? 'origin' : remotes[0] || null;
  const out = new Map();
  for (const r of refs) {
    const name = remote ? (r.startsWith(`refs/remotes/${remote}/`) ? r.slice(`refs/remotes/${remote}/`.length) : null) : r.startsWith('refs/heads/') ? r.slice('refs/heads/'.length) : null;
    if (name && name !== 'HEAD' && isBranch(name)) out.set(name, r);
  }
  const head = remote ? git(repo, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]).replace(`${remote}/`, '') : '';
  return { refs: out, default_branch: head || TRUNKS.find((t) => out.has(t)) || null };
}

// Is `into` made of merges from `from`? Counts the merge commits on `into`'s
// own line whose merged-in parent was once the tip of `from`. A feature branch
// merged into main was never the tip of production, so the direction is not
// ambiguous the way plain ancestry is.
function lineage(repo, refs, names) {
  const line = new Map(names.map((n) => [n, new Set(git(repo, ['rev-list', '--first-parent', '-n', '3000', refs.get(n)]).split('\n').filter(Boolean))]));
  const merged = new Map(names.map((n) => [n, git(repo, ['log', '--first-parent', '--merges', '-n', String(MAX_MERGES), '--format=%P', refs.get(n)]).split('\n').filter(Boolean).map((l) => l.split(' ')[1]).filter(Boolean)]));
  const out = [];
  for (const into of names) {
    const parents = merged.get(into);
    if (!parents.length) continue;
    for (const from of names) {
      if (from === into) continue;
      const n = parents.filter((p) => line.get(from).has(p)).length;
      if (n >= 1 && n / parents.length >= 0.5) out.push({ from, into, merges: n, of: parents.length });
    }
  }
  return out;
}

export function probe(repo) {
  const { refs, default_branch } = listBranches(repo);
  let loaded = null;
  let config_error = null;
  try {
    loaded = loadConfig(repo);
  } catch (e) {
    config_error = e.message;
  }
  const release = loaded?.config.release || {};
  const known = loaded?.known_targets || [];

  const dir = join(repo, '.github/workflows');
  const workflows = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => readWorkflow(f, readText(join(dir, f)))).filter((w) => w.push || w.environments.length);
  const hosting = [...new Set(Object.entries(HOSTING).filter(([f]) => existsSync(join(repo, f)) || existsSync(join(repo, 'infra', f))).map(([, p]) => p))];

  // Branches worth looking at: the ones whose name, a config or a deploy workflow says "environment".
  const interesting = new Set();
  const add = (b) => b && refs.has(b) && interesting.add(b);
  [default_branch, ...TRUNKS, ...Object.keys(ENV_OF), release.main_branch, release.production_branch, ...known.map((t) => t.branch)].forEach(add);
  for (const w of workflows) if (w.deploys) (w.push || []).forEach(add);
  const names = [...interesting].slice(0, 8);
  const feeds = names.length > 1 ? lineage(repo, refs, names) : [];

  // The name of the environment each branch feeds.
  const prodBranch = [release.production_branch, 'production', 'prod', 'live', 'release'].find((b) => b && names.includes(b)) || null;
  const stagingBranch = ['staging', 'stage'].find((b) => names.includes(b)) || null;
  const previews = hosting.some((h) => ['vercel', 'netlify', 'render', 'cloudflare'].includes(h));
  // A branch named for an environment, or mapped by a config, keeps that name.
  const byName = (b) => {
    const k = known.find((t) => t.branch === b);
    if (k) return { env: k.env, why: [`.claude/check-infra-and-migrations.json maps ${b} to ${k.env}`] };
    if (b === prodBranch) return { env: 'production', why: [b === release.production_branch ? `release.production_branch is ${b}` : `the branch is called ${b}`] };
    if (ENV_OF[b]) return { env: ENV_OF[b], why: [`the branch is called ${b}`] };
    return null;
  };
  // Any other branch (a trunk) is named by what a deploy workflow calls it, else by where it sits.
  const byPlace = (b, taken) => {
    const named = [...new Set(workflows.filter((w) => w.deploys && (w.push || []).includes(b)).flatMap((w) => w.environments))];
    if (named.length === 1 && !taken.has(named[0])) return { env: named[0], why: [`a workflow that runs on a push to ${b} names the environment ${named[0]}`] };
    if (!prodBranch) return { env: 'production', why: [`there is no production branch, so ${b} is taken as production`] };
    if (!stagingBranch) return { env: 'staging', why: [`there is a ${prodBranch} branch and no staging branch, so ${b} is taken as staging`] };
    return { env: previews ? 'preview' : 'development', why: [`${b} sits before ${stagingBranch} and ${prodBranch}`] };
  };
  const drafts = [];
  const taken = new Set();
  const keep = (b, d) => {
    if (!d || taken.has(d.env)) return; // two branches, one name: the first keeps it
    taken.add(d.env);
    drafts.push({ env: d.env, branch: b, why: d.why });
  };
  for (const b of names) keep(b, byName(b));
  for (const b of names) if (!drafts.some((d) => d.branch === b)) keep(b, byPlace(b, taken));
  // Only branches that take part: fed by another, feeding another, or named for an environment.
  const linked = new Set(feeds.flatMap((f) => [f.from, f.into]));
  let stages = drafts.filter((d) => linked.has(d.branch) || ENV_OF[d.branch] || known.some((t) => t.branch === d.branch) || d.branch === default_branch || d.branch === prodBranch);
  const rank = (d) => RANK[d.env] ?? 6;
  stages.sort((a, b) => {
    if (feeds.some((f) => f.from === a.branch && f.into === b.branch) && !feeds.some((f) => f.from === b.branch && f.into === a.branch)) return -1;
    if (feeds.some((f) => f.from === b.branch && f.into === a.branch) && !feeds.some((f) => f.from === a.branch && f.into === b.branch)) return 1;
    return rank(a) - rank(b);
  });
  stages = stages.slice(-MAX_STAGES);
  stages = stages.map((s, i) => {
    const out = { env: s.env, branch: s.branch, how: 'push', why: [...s.why] };
    // Two branches that share old history can both look like the feeder: the
    // one more merges came from wins, and on a tie the nearest earlier stage.
    const earlier = stages.slice(0, i).reverse();
    const near = (f) => earlier.findIndex((x) => x.branch === f.from);
    const feeders = feeds.filter((f) => f.into === s.branch && stages.some((x) => x.branch === f.from)).sort((a, b) => b.merges - a.merges || (near(a) === -1 ? 99 : near(a)) - (near(b) === -1 ? 99 : near(b)));
    const from = (feeders.length ? stages.find((x) => x.branch === feeders[0].from) : null) || earlier[0] || null;
    if (from) {
      out.how = 'pr';
      out.from = from.env;
      const f = feeders.find((x) => x.from === from.branch);
      out.why.push(f ? `${f.merges} of the last ${f.of} merges on ${s.branch} came from ${from.branch}` : `no merge history between them yet: ${from.env} is the stage before it`);
    } else out.why.push(`nothing feeds ${s.branch} from another stage: every merge into it deploys`);
    // The most specific deploy workflow for this branch; one that deploys the app before one that deploys infrastructure.
    const wf = workflows.filter((w) => w.deploys && (w.push || []).includes(s.branch)).sort((a, b) => a.push.length - b.push.length || Number(/infra/i.test(a.file)) - Number(/infra/i.test(b.file)))[0];
    if (wf) {
      out.deploy_workflow = wf.file;
      out.why.push(`${wf.file} runs on a push to ${s.branch}`);
    }
    return out;
  });
  const last = stages.filter((s) => /^prod/i.test(s.env) || s.branch === prodBranch).pop() || (stages.length > 1 ? stages[stages.length - 1] : null);
  if (last) last.production = true;

  return {
    configured: loaded?.found || [],
    needs_setup: loaded ? loaded.needs_setup : true,
    ...(config_error ? { config_error } : {}),
    reuse: Object.fromEntries(Object.entries(loaded?.sources || {}).filter(([, file]) => !file.endsWith(OWN_FILE))),
    known_targets: known,
    default_branch,
    branches: names,
    workflows: workflows.filter((w) => w.deploys || w.environments.length).slice(0, 15).map((w) => ({ file: w.file, push_branches: w.push || [], environments: w.environments, deploys: w.deploys })),
    hosting,
    lineage: feeds,
    stages,
    promotable: stages.filter((s) => s.how === 'pr').length,
    ...(stages.length < 2 ? { note: 'one environment branch found: there is nothing to promote between. If code reaches production another way (a tag, a provider button), record it as a `manual` stage.' } : {}),
  };
}

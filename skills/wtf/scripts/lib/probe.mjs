// What this repo already says about where its bugs are tracked, where it runs
// and what watches it. Setup turns each hit into the recommended answer, so the
// user confirms instead of typing. Reads file names, package.json dependency
// names, branch names and commit subjects. Never file bodies, never the network.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const HOSTING = ['aws', 'render', 'vercel', 'fly', 'netlify', 'heroku', 'railway', 'cloudflare', 'gcp', 'azure', 'other'];

// provider -> files whose presence says "deployed there", and the CLI that reads it.
const HOSTS = {
  aws: { files: ['cdk.json', 'samconfig.toml', 'serverless.yml', 'serverless.yaml', 'sst.config.ts', 'amplify.yml', 'buildspec.yml', 'appspec.yml', 'copilot'], deps: ['aws-cdk-lib', 'sst', 'serverless'], cli: 'aws' },
  render: { files: ['render.yaml'], deps: [], cli: 'render' },
  vercel: { files: ['vercel.json', '.vercel'], deps: [], cli: 'vercel' },
  fly: { files: ['fly.toml'], deps: [], cli: 'flyctl' },
  netlify: { files: ['netlify.toml'], deps: [], cli: 'netlify' },
  heroku: { files: ['Procfile', 'app.json'], deps: [], cli: 'heroku' },
  railway: { files: ['railway.json', 'railway.toml'], deps: [], cli: 'railway' },
  cloudflare: { files: ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'], deps: ['wrangler'], cli: 'wrangler' },
  gcp: { files: ['app.yaml', 'cloudbuild.yaml', 'firebase.json'], deps: [], cli: 'gcloud' },
  azure: { files: ['azure.yaml', 'azure-pipelines.yml'], deps: [], cli: 'az' },
};

const RUNTIME = {
  sentry: { files: ['.sentryclirc', 'sentry.properties'], deps: /^@sentry\//, cli: 'sentry-cli' },
  posthog: { files: [], deps: /^posthog-(js|node)$/ },
  datadog: { files: ['datadog.yaml'], deps: /^(dd-trace|@datadog\/.+)$/ },
  newrelic: { files: ['newrelic.js', 'newrelic.yml'], deps: /^newrelic$/ },
};

// Ticket ids as they show up in branch names and commit subjects.
const ID_SHAPES = [
  { type: 'clickup', id_pattern: '86[0-9a-z]{7}', re: /\b(?:CU-)?86[0-9a-z]{7}\b/gi },
  { type: 'linear', id_pattern: '[A-Z]{2,10}-[0-9]+', re: /\b[A-Z]{2,10}-\d+\b/g },
];

const git = (repo, args) => {
  try {
    return execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};
const hasCli = (name) => {
  try {
    execFileSync('sh', ['-c', 'command -v "$1"', 'sh', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

export function probe(repo, { cli = hasCli } = {}) {
  const here = (f) => existsSync(join(repo, f));
  const pkg = readJson(join(repo, 'package.json')) || {};
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const top = (() => {
    try {
      return readdirSync(repo);
    } catch {
      return [];
    }
  })();

  const hosting = [];
  for (const [provider, h] of Object.entries(HOSTS)) {
    const why = [...h.files.filter(here), ...h.deps.filter((d) => deps.includes(d)).map((d) => `dependency ${d}`)];
    if (top.some((f) => /\.tf$/.test(f)) && provider === 'aws' && !why.length && cli('aws')) why.push('terraform files and the aws CLI');
    if (why.length) hosting.push({ provider, why, cli: h.cli, cli_installed: cli(h.cli) });
  }

  const runtime = [];
  for (const [source, r] of Object.entries(RUNTIME)) {
    const why = [...r.files.filter(here), ...deps.filter((d) => r.deps.test(d)).map((d) => `dependency ${d}`)];
    if (top.some((f) => f.startsWith(`${source}.`) && /config/.test(f))) why.push(`${source} config file`);
    if (why.length) runtime.push({ source, why, ...(r.cli ? { cli_installed: cli(r.cli) } : {}) });
  }

  const tracker = [];
  const changelog = readJson(join(repo, '.claude/changelog.json'));
  if (changelog?.tracker?.type) tracker.push({ type: changelog.tracker.type, why: ['.claude/changelog.json'], reuse: changelog.tracker });
  const names = `${git(repo, ['log', '-200', '--format=%s'])}\n${git(repo, ['branch', '-a', '--format=%(refname:short)'])}`;
  for (const s of ID_SHAPES) {
    const hits = new Set(names.match(s.re) || []);
    if (hits.size >= 3) tracker.push({ type: s.type, why: [`${hits.size} ids like ${[...hits][0]} in branch names and commit subjects`], id_pattern: s.id_pattern });
  }
  const remote = git(repo, ['remote', 'get-url', 'origin']);
  if (/github\.com[:/]/.test(remote)) tracker.push({ type: 'github', why: ['origin is on GitHub'] });

  const branches = git(repo, ['branch', '-a', '--format=%(refname:short)']).split('\n').map((b) => b.replace(/^origin\//, ''));
  const release = changelog?.release
    ? { reuse: true, why: ['.claude/changelog.json'] }
    : {
        production_branch: ['production', 'prod', 'release', 'live'].find((b) => branches.includes(b)) || null,
        staging_branch: ['staging', 'develop', 'dev'].find((b) => branches.includes(b)) || null,
        latest_tag: git(repo, ['describe', '--tags', '--abbrev=0']) || null,
      };

  return {
    configured: here('.claude/wtf.json'),
    tracker, hosting, runtime, release,
    local: here('.claude/launch.json') ? ['.claude/launch.json'] : [],
  };
}

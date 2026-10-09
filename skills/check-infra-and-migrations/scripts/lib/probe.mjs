// What this repo already says about its migrations and its infrastructure.
// Setup turns each hit into the recommended answer, so the user confirms
// instead of typing, and a run with no config file uses the same hits. Reads
// file names, package.json script names, workflow text and the NAMES of
// branches. Never a value from an env file, never the network.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';

const MIGRATION_APPLY = /drizzle-kit\s+(migrate|push)|supabase\s+(db\s+push|migration\s+up)|prisma\s+migrate\s+deploy|(rails|rake)\s+db:migrate|alembic\s+upgrade|manage\.py\s+migrate|knex\s+migrate:latest|flyway\s+migrate|\bdb:migrate\b/;
const INFRA_APPLY = /cdk\s+deploy|terraform\s+apply|sst\s+deploy|(serverless|sls)\s+deploy|pulumi\s+up|cloudformation\s+deploy|sam\s+deploy|kubectl\s+apply|helm\s+upgrade/;
const SERVICE_FILES = ['render.yaml', 'vercel.json', 'fly.toml', 'netlify.toml', 'wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'app.yaml', 'railway.json', 'railway.toml'];
const ENV_FILES = ['.env.example', '.env.sample', '.env.template', '.env.local.example'];

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const readText = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};
const git = (repo, args) => {
  try {
    return execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};

// Up to `cap` repo-relative paths, skipping what is never source.
function walk(repo, cap = 6000) {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '.venv', 'target', '.claude', 'cdk.out', '.terraform']);
  const stack = [''];
  while (stack.length && out.length < cap) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(join(repo, dir), { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(rel);
      else out.push(rel);
    }
  }
  return out;
}
const dirOf = (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
const under = (dir) => (dir ? `${dir}/**` : '**');

export function probe(repo) {
  const files = walk(repo);
  const has = (f) => files.includes(f);
  const dirs = new Set(files.map(dirOf));

  const migrations = [];
  const seen = new Set();
  const mig = (tool, where, why) => {
    const k = where.dir || where.paths.join(',');
    if (seen.has(k)) return;
    seen.add(k);
    migrations.push({ tool, ...where, why });
  };
  for (const f of files.filter((x) => x.endsWith('/meta/_journal.json'))) mig('drizzle', { dir: f.slice(0, -'/meta/_journal.json'.length) }, [f]);
  if (dirs.has('supabase/migrations')) mig('supabase', { dir: 'supabase/migrations' }, ['supabase/migrations']);
  for (const f of files.filter((x) => x.endsWith('/migration_lock.toml'))) mig('prisma', { dir: dirOf(f) }, [f]);
  if (dirs.has('db/migrate')) mig('rails', { dir: 'db/migrate' }, ['db/migrate']);
  if (has('alembic.ini')) {
    const d = ['alembic/versions', 'migrations/versions'].find((x) => dirs.has(x));
    if (d) mig('alembic', { dir: d }, ['alembic.ini']);
  }
  if (has('manage.py') && files.some((f) => /\/migrations\/\d{4}_[^/]+\.py$/.test(f))) mig('django', { paths: ['**/migrations/*.py'] }, ['manage.py']);
  const knex = files.find((f) => /(^|\/)knexfile\.\w+$/.test(f));
  if (knex && dirs.has(join(dirOf(knex), 'migrations'))) mig('knex', { dir: join(dirOf(knex), 'migrations') }, [knex]);
  for (const d of [...dirs].filter((x) => /(^|\/)(migrations?|sql\/migrations)$/.test(x) || /(^|\/)db\/migration$/.test(x))) {
    if (files.some((f) => dirOf(f) === d && f.endsWith('.sql'))) mig(files.some((f) => dirOf(f) === d && /\/V\d+__/.test(f)) ? 'flyway' : 'sql', { dir: d }, [`${d}/*.sql`]);
  }

  const infra = [];
  for (const f of files.filter((x) => /(^|\/)cdk\.json$/.test(x))) infra.push({ tool: 'cdk', paths: dirOf(f) ? [under(dirOf(f))] : ['lib/**', 'bin/**', 'cdk.json'], why: [f] });
  const tf = [...new Set(files.filter((x) => /\.tf$/.test(x)).map((x) => x.split('/')[0]))];
  if (tf.length) infra.push({ tool: 'terraform', paths: ['**/*.tf', '**/*.tfvars'], why: [`*.tf under ${tf.slice(0, 3).join(', ')}`] });
  for (const f of files.filter((x) => /(^|\/)sst\.config\.\w+$/.test(x))) infra.push({ tool: 'sst', paths: [f, ...(dirs.has(join(dirOf(f), 'infra')) ? [under(join(dirOf(f), 'infra'))] : [])], why: [f] });
  for (const f of files.filter((x) => /(^|\/)serverless\.ya?ml$/.test(x))) infra.push({ tool: 'serverless', paths: [f], why: [f] });
  for (const f of files.filter((x) => /(^|\/)Pulumi\.yaml$/.test(x))) infra.push({ tool: 'pulumi', paths: [under(dirOf(f))], why: [f] });
  for (const f of files.filter((x) => /(^|\/)template\.ya?ml$|\.template\.json$/.test(x))) infra.push({ tool: 'cloudformation', paths: [f], why: [f] });
  const service = SERVICE_FILES.filter(has);
  if (service.length) infra.push({ tool: 'service', paths: service, why: service });
  for (const d of ['k8s', 'kubernetes', 'helm', 'charts'].filter((x) => [...dirs].some((y) => y === x || y.startsWith(`${x}/`)))) infra.push({ tool: 'kubernetes', paths: [under(d)], why: [d] });

  // Who applies them: workflow files and package scripts that name the tool's apply command.
  const workflows = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) || f === '.gitlab-ci.yml' || f === '.circleci/config.yml');
  const scripts = Object.entries(readJson(join(repo, 'package.json'))?.scripts || {});
  const appliers = (re) => [
    ...workflows.filter((f) => re.test(readText(join(repo, f)))),
    ...scripts.filter(([, cmd]) => re.test(String(cmd))).map(([name]) => `package.json script ${name}`),
  ];
  const migration_applied_by = appliers(MIGRATION_APPLY);
  const infra_applied_by = appliers(INFRA_APPLY);

  const branches = git(repo, ['branch', '-a', '--format=%(refname:short)']).split('\n').map((b) => b.replace(/^origin\//, '')).filter(Boolean);
  const loaded = (() => {
    try {
      return loadConfig(repo);
    } catch {
      return null;
    }
  })();
  const prod = loaded?.config.release?.production_branch || ['production', 'prod', 'release', 'live'].find((b) => branches.includes(b)) || null;
  const targets = [...(prod ? [{ branch: prod, env: 'production' }] : []), ...(branches.includes('staging') ? [{ branch: 'staging', env: 'staging' }] : [])];

  return {
    configured: loaded?.found || [],
    needs_setup: loaded ? loaded.needs_setup : true,
    reuse: Object.fromEntries(Object.entries(loaded?.sources || {}).filter(([, file]) => !file.endsWith('check-infra-and-migrations.json'))),
    migrations, infra,
    migration_applied_by, infra_applied_by,
    pipeline: workflows.filter((f) => /deploy|release|migrat|infra/i.test(f)),
    env_files: ENV_FILES.filter(has),
    targets,
    environments: (loaded?.config.environments || []).map((e) => e.name),
  };
}

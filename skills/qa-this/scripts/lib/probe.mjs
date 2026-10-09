// What this repo already says about how it is tested and where it runs. Setup
// turns each hit into the recommended answer, so the user confirms instead of
// typing. Reads file names, package.json script and dependency names, and the
// NAMES of environment variables. Never a value, never the network.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';

const RUNNERS = [
  { name: 'vitest', dep: /^vitest$/, suite: 'unit', run: 'vitest run' },
  { name: 'jest', dep: /^jest$/, suite: 'unit', run: 'jest' },
  { name: 'mocha', dep: /^mocha$/, suite: 'unit', run: 'mocha' },
  { name: 'playwright', dep: /^@playwright\/test$/, suite: 'e2e', run: 'playwright test' },
  { name: 'cypress', dep: /^cypress$/, suite: 'e2e', run: 'cypress run --spec' },
];
const OTHER = [
  { name: 'pytest', files: ['pytest.ini', 'pyproject.toml', 'conftest.py'], suite: 'unit', command: 'pytest' },
  { name: 'go test', files: ['go.mod'], suite: 'unit', command: 'go test' },
  { name: 'cargo test', files: ['Cargo.toml'], suite: 'unit', command: 'cargo test' },
  { name: 'rspec', files: ['.rspec'], suite: 'unit', command: 'bundle exec rspec' },
];
const DB_VAR = /^(DATABASE_URL|DIRECT_URL|POSTGRES\w*_URL|PG(HOST|DATABASE)|MYSQL_\w*URL|SUPABASE_DB_URL|DB_(URL|HOST|NAME))$/;
const ENV_FILES = ['.env.example', '.env.sample', '.env.template', '.env.local.example'];

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

// Up to `cap` repo-relative paths, skipping what is never source.
function walk(repo, cap = 4000) {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '.venv', 'target', '.claude']);
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

export function probe(repo) {
  const here = (f) => existsSync(join(repo, f));
  const pkg = readJson(join(repo, 'package.json')) || {};
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const pm = here('pnpm-lock.yaml') ? 'pnpm' : here('yarn.lock') ? 'yarn' : here('bun.lockb') || here('bun.lock') ? 'bun' : 'npm';
  const exec = pm === 'npm' ? 'npx' : pm === 'bun' ? 'bunx' : pm;

  const tests = [];
  for (const r of RUNNERS) {
    const dep = deps.find((d) => r.dep.test(d));
    if (dep) tests.push({ runner: r.name, suite: r.suite, command: `${exec} ${r.run}`, why: [`dependency ${dep}`] });
  }
  for (const o of OTHER) {
    const why = o.files.filter(here);
    if (why.length && !(o.name === 'pytest' && !why.includes('pytest.ini') && !why.includes('conftest.py'))) tests.push({ runner: o.name, suite: o.suite, command: o.command, why });
  }

  if (pkg.scripts?.test && !tests.some((t) => t.suite === 'unit')) tests.push({ runner: 'package script', suite: 'unit', command: pm === 'npm' ? 'npm test --' : `${pm} test`, why: ['package.json has a test script'] });

  // Test globs from where test files already live.
  const files = walk(repo);
  const shapes = [
    [/\.test\.(ts|tsx|js|jsx|mjs)$/, (ext) => `**/*.test.${ext}`],
    [/\.spec\.(ts|tsx|js|jsx|mjs)$/, (ext) => `**/*.spec.${ext}`],
    [/(^|\/)test_[^/]+\.py$/, () => '**/test_*.py'],
    [/_test\.go$/, () => '**/*_test.go'],
    [/_spec\.rb$/, () => '**/*_spec.rb'],
  ];
  const counts = {};
  for (const f of files) {
    for (const [re, glob] of shapes) {
      const m = f.match(re);
      if (m) {
        const g = glob(m[1]);
        counts[g] = (counts[g] || 0) + 1;
      }
    }
  }
  const globs = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([glob, n]) => ({ glob, files: n }));
  // Test files and nothing that names a runner: Node's own.
  const plain = globs.find((g) => /\.(test|spec)\.(mjs|js)$/.test(g.glob));
  if (plain && !tests.some((t) => t.suite === 'unit')) tests.push({ runner: 'node:test', suite: 'unit', command: 'node --test', why: [`${plain.files} files like ${plain.glob} and no test runner dependency`] });

  const vars = new Set();
  for (const f of ENV_FILES.filter(here)) {
    for (const line of readFileSync(join(repo, f), 'utf8').split('\n')) {
      const name = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/)?.[1];
      if (name && DB_VAR.test(name)) vars.add(name);
    }
  }

  const { config, sources, found, missing } = loadConfig(repo);
  return {
    configured: found, missing,
    reuse: Object.fromEntries(Object.entries(sources).filter(([, file]) => file !== '.claude/qa-this.json')),
    tests, test_globs: globs,
    database_vars: [...vars],
    local: ['.claude/launch.json', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'Procfile.dev'].filter(here),
    environments: (config.environments || []).map((e) => e.name),
  };
}

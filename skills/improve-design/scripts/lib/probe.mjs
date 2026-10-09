// What this repo and this machine already say, so setup can offer answers
// instead of asking for them: package manager, dev script, framework, check
// scripts, which env files exist (names only), where impeccable is installed,
// and whether gh is there. Never a file's contents beyond package.json, never
// the network.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { copyRefusal } from './dev.mjs';

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const FRAMEWORKS = [['next', 'next'], ['astro', 'astro'], ['@remix-run/dev', 'remix'], ['@sveltejs/kit', 'sveltekit'], ['nuxt', 'nuxt'], ['vite', 'vite'], ['react-scripts', 'create-react-app']];
const ENV_FILES = ['.env.local', '.env', '.env.development.local', '.env.development'];
const GATE_SCRIPTS = ['typecheck', 'type-check', 'check-types', 'tsc', 'lint'];
const byVersion = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map((n) => parseInt(n, 10) || 0));
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
};

// impeccable's skill folder: the one with scripts/detect.mjs and reference/critique.md.
// IMPROVE_DESIGN_IMPECCABLE points at it directly (tests, or an install somewhere else).
export function findImpeccable(repo) {
  const ok = (dir) => dir && existsSync(join(dir, 'scripts/detect.mjs'));
  const candidates = [];
  if (process.env.IMPROVE_DESIGN_IMPECCABLE) candidates.push({ dir: process.env.IMPROVE_DESIGN_IMPECCABLE, version: null });
  else {
    const cache = join(homedir(), '.claude/plugins/cache/impeccable/impeccable');
    let versions = [];
    try {
      versions = readdirSync(cache).filter((v) => /^\d+\.\d+\.\d+/.test(v)).sort(byVersion);
    } catch {}
    for (const v of versions) candidates.push({ dir: join(cache, v, 'skills/impeccable'), version: v });
    for (const dir of [join(repo || '.', '.claude/skills/impeccable'), join(homedir(), '.claude/skills/impeccable')]) candidates.push({ dir, version: null });
  }
  const hit = candidates.find((c) => ok(c.dir));
  if (!hit) return null;
  const version = hit.version || readFileSync(join(hit.dir, 'SKILL.md'), 'utf8').match(/^version:\s*(\S+)/m)?.[1] || null;
  return { dir: hit.dir, version, detect: join(hit.dir, 'scripts/detect.mjs'), has_rubric: existsSync(join(hit.dir, 'reference/critique.md')) };
}

export const hasGh = () => {
  if (process.env.IMPROVE_DESIGN_GH_STUB) return true;
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export function probe(repo) {
  const here = (f) => existsSync(join(repo, f));
  const { config, found, missing, sources } = loadConfig(repo);
  const cwd = config.dev.cwd;
  const pkg = readJson(join(repo, cwd, 'package.json')) || {};
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const pm = here('pnpm-lock.yaml') ? 'pnpm' : here('yarn.lock') ? 'yarn' : here('bun.lockb') || here('bun.lock') ? 'bun' : 'npm';
  const run = pm === 'npm' ? 'npm run' : pm;
  const framework = FRAMEWORKS.find(([dep]) => deps.includes(dep))?.[1] || null;
  const scripts = pkg.scripts || {};
  const install = { pnpm: 'pnpm install --frozen-lockfile --prefer-offline', yarn: 'yarn install --frozen-lockfile', bun: 'bun install --frozen-lockfile', npm: 'npm ci --prefer-offline' }[pm];
  return {
    configured: found, missing, reuse: sources,
    package_manager: pm, framework,
    suggest: {
      dev: scripts.dev ? { cwd, install, command: pm === 'npm' ? 'npm run dev -- --port {port}' : `${pm} dev --port {port}`, why: `package.json has a dev script${framework ? ` (${framework})` : ''}` } : null,
      gates: GATE_SCRIPTS.filter((s) => scripts[s]).map((s) => `${run} ${s}`),
      // Names of env files that exist and could be copied. A name, never a value.
      copy: ENV_FILES.map((f) => (cwd === '.' ? f : `${cwd}/${f}`)).filter((f) => here(f) && copyRefusal(repo, f) === null),
    },
    impeccable: findImpeccable(repo),
    gh: hasGh(),
  };
}

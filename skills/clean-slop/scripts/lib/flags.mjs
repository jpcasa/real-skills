// The shortcuts a fix can take: ways to turn a check green without fixing
// what it found. Each hit is one question for the user, never a refusal: a
// test that is wrong because the pull request changed behaviour on purpose
// is a real case, and whether this is one is not the script's to say. Pure.

import { createHash } from 'node:crypto';
import { anyMatch } from './glob.mjs';

export const FLAGS = ['ci_config', 'check_config', 'test_removed', 'test_skipped', 'test_edited', 'suppression', 'snapshot', 'dependencies', 'large'];

const CI_CONFIG = ['.github/**', '.circleci/**', '.buildkite/**', '.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml'];
const CHECK_CONFIG = /^(?:\.eslintrc(?:\..+)?|eslint\.config\.\w+|\.eslintignore|tsconfig(?:\..+)?\.json|jsconfig\.json|biome\.jsonc?|\.prettierrc(?:\..+)?|prettier\.config\.\w+|\.prettierignore|jest\.config\.\w+|vitest\.(?:config|workspace)\.\w+|playwright\.config\.\w+|cypress\.config\.\w+|knip\.jsonc?|ruff\.toml|\.ruff\.toml|mypy\.ini|\.flake8|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|pyrightconfig\.json|\.golangci\.ya?ml|clippy\.toml|rustfmt\.toml|\.rubocop\.yml|\.editorconfig)$/;
const LOCKFILES = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock)$/;
const MANIFESTS = /^(?:pyproject\.toml|requirements[\w.-]*\.txt|Pipfile|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/;
const PACKAGE_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions', 'pnpm', 'packageManager', 'engines'];
const SNAPSHOT = /(?:^|\/)__snapshots__\/|\.snap$|-snapshots\/|\.ambr$/;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|specs?|e2e)\/|\.(?:test|spec)\.[\w.]+$|_test\.\w+$|(?:^|\/)test_[^/]+\.py$|_spec\.rb$|Tests?\.(?:java|kt|cs)$/;
// A skipped test still counts as a test: skipping is its own flag.
const TEST_CASE = /\b(?:it|test)(?:\.\w+)*(?:\([^)]*\))?\s*\(|^\s*(?:async\s+)?def test_\w+|^\s*func Test\w+|#\[(?:tokio::)?test\]|@Test\b|^\s*(?:it|specify|scenario)\s+['"]/gm;
const SKIP = /\b(?:it|test|describe|suite|context)\.(?:skip|only|todo)\b|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)|@unittest\.skip|\bt\.Skip(?:f|Now)?\(|#\[ignore\]|@Disabled\b|@Ignore\b|\bpending\b\s*['"(]/;
const SUPPRESS = /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|biome-ignore|#\s*type:\s*ignore|#\s*noqa|#\s*pylint:\s*disable|\/\/\s*nolint|#\[allow\(|@SuppressWarnings|\bas any\b|rubocop:disable/;

export const isTest = (path) => TEST_FILE.test(path);
const base = (path) => path.split('/').pop();
const hashOf = (...parts) => createHash('sha1').update(parts.map((p) => String(p ?? '')).join('\u0000')).digest('hex').slice(0, 16);
const count = (text, re) => (String(text ?? '').match(re) || []).length;

// Lines the fix wrote that were not there before, each once per extra copy.
export function addedLines(before, after) {
  const had = new Map();
  for (const l of String(before ?? '').split('\n')) had.set(l.trim(), (had.get(l.trim()) || 0) + 1);
  const out = [];
  for (const l of String(after ?? '').split('\n')) {
    const k = l.trim();
    if (had.get(k)) had.set(k, had.get(k) - 1);
    else if (k) out.push(k);
  }
  return out;
}

function packageChanged(before, after) {
  try {
    const [a, b] = [JSON.parse(before), JSON.parse(after)];
    return PACKAGE_KEYS.filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
  } catch {
    return ['(not readable as JSON)'];
  }
}

function scriptsChanged(before, after) {
  try {
    const [a, b] = [JSON.parse(before).scripts || {}, JSON.parse(after).scripts || {}];
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
  } catch {
    return [];
  }
}

// changes: [{ file, before, after }] — text, or null when the file is not there on that side
// failures: the round's failures (their errors name the failing files)
// opts: { check_config: [globs], max_files, max_lines, lines_changed }
// -> [{ id, flag, file, reason, hash }]
export function flagsOf(changes, failures, opts = {}) {
  const out = [];
  const named = new Set((failures || []).flatMap((f) => (f.errors || []).map((e) => e.file).filter(Boolean)));
  const isNamed = (file) => [...named].some((n) => n === file || file.endsWith(`/${n}`) || n.endsWith(`/${file}`));
  const add = (flag, file, reason, content) => out.push({ id: `${flag}:${file}`, flag, file, reason, hash: hashOf(flag, file, content) });
  for (const c of changes) {
    const { file, before, after } = c;
    const name = base(file);
    const first = (re, list) => list.find((l) => re.test(l));
    if (anyMatch(CI_CONFIG, file)) add('ci_config', file, 'changes how CI itself runs', after);
    if (CHECK_CONFIG.test(name) || anyMatch(opts.check_config || [], file)) add('check_config', file, 'changes the configuration of a check', after);
    if (SNAPSHOT.test(file)) add('snapshot', file, after === null ? 'removes a snapshot' : 'changes a snapshot: the check now expects what the code does', after);
    if (LOCKFILES.test(name) || MANIFESTS.test(name)) add('dependencies', file, 'changes what is installed', after);
    else if (name === 'package.json' && before !== null && after !== null) {
      const keys = packageChanged(before, after);
      if (keys.length) add('dependencies', file, `changes ${keys.join(', ')}`, after);
      // `"test": "vitest run || true"` turns the check green and fixes nothing.
      const scripts = scriptsChanged(before, after);
      if (scripts.length) add('check_config', file, `changes the package script${scripts.length === 1 ? '' : 's'} ${scripts.slice(0, 5).join(', ')}: what a check runs`, after);
    }
    if (isTest(file) && !SNAPSHOT.test(file)) {
      if (after === null) add('test_removed', file, 'deletes a test file', after);
      else {
        const [was, is] = [count(before, TEST_CASE), count(after, TEST_CASE)];
        if (before !== null && is < was) add('test_removed', file, `leaves ${is} test case${is === 1 ? '' : 's'} where there were ${was}`, after);
        if (before !== null && isNamed(file)) add('test_edited', file, 'edits a test that a failure names: right only when the test is what was wrong', after);
      }
    }
    if (after !== null) {
      const added = addedLines(before, after);
      const skip = first(SKIP, added);
      if (skip) add('test_skipped', file, `adds a skip or focus marker: ${skip.slice(0, 120)}`, after);
      const sup = first(SUPPRESS, added);
      if (sup) add('suppression', file, `adds a suppression: ${sup.slice(0, 120)}`, after);
    }
  }
  const [files, lines] = [changes.length, opts.lines_changed ?? 0];
  if (files > (opts.max_files ?? 10) || lines > (opts.max_lines ?? 300)) add('large', '*', `${files} files and ${lines} lines: more than a fix for a red check usually takes`, `${files}:${lines}`);
  return out;
}

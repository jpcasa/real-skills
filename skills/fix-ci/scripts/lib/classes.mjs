// What kind of failure a red job is, and whether its command may be run on
// this machine. Both are decided from what the job's log and GitHub say, and
// both carry the line or the fact that decided them. Pure.

export const CLASSES = ['code', 'infra', 'config', 'external', 'derived'];
export const REPRO = ['run', 'ask', 'never'];

// The runner or the network failed, not the code. [pattern, what it is]
export const INFRA = [
  [/lost communication with the server|runner has received a shutdown signal|the hosted runner (?:lost|encountered)|runner.*(?:offline|did not connect)/i, 'the runner was lost'],
  [/no space left on device|ENOSPC/i, 'the runner ran out of disk'],
  [/\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ENOTFOUND)\b|socket hang up|TLS handshake timeout|connection reset by peer/i, 'a network error'],
  [/\b(?:502|503|504) (?:Bad Gateway|Service Unavailable|Gateway Time-?out)|ERR_PNPM_FETCH_\d+|npm ERR! code E5\d\d|received unexpected HTTP status: 5\d\d/i, 'a registry or a service answered with a server error'],
  [/API rate limit exceeded|secondary rate limit|rate limit(?:ed)? .*(?:exceeded|reached)|toomanyrequests/i, 'a rate limit'],
  [/failed to download action|unable to (?:resolve|download) action|could not download.*archive/i, 'an action could not be downloaded'],
  [/the operation was cancell?ed|exceeded the maximum execution time/i, 'the job was cancelled or ran out of time'],
];
// A secret or a permission is missing: someone with access has to fix it.
export const CONFIG = [
  [/Resource not accessible by integration/i, 'the workflow token lacks a permission'],
  [/Input required and not supplied/i, 'an action input is empty, usually a secret this run cannot read'],
  [/Bad credentials|HTTP 401\b|401 Unauthorized|authentication failed|could not read Username|Permission denied \(publickey\)/i, 'credentials were refused'],
  [/HTTP 403\b|403 Forbidden|permission to .* denied|not authorized to perform/i, 'a permission was refused'],
  [/(?:secret|token|api[_ -]?key)\S* (?:is|was) (?:not set|missing|empty|required)|missing required (?:secret|env)/i, 'a secret is not set'],
];
const CONCLUSION_INFRA = { timed_out: 'the job ran out of time', cancelled: 'the job was cancelled', startup_failure: 'the workflow could not start', stale: 'GitHub marked the run stale' };

// A command that writes somewhere other than this folder. Never run here.
// The long words count anywhere in a word (`predeploy`, `db:migrate`,
// `scripts/deploy.mjs`); the short ones only as a word of their own. A flag is
// not a command: `cargo build --release` builds. The shell drops quotes and
// backslashes before it runs anything, so they are dropped before reading.
const WRITE_ANY = /(?<!--[\w-]*)(deploy|publish|release|migrat|upload|terraform|pulumi|kubectl)/i;
const WRITE_WORD = /(?<![A-Za-z0-9])(?<!--[\w-]*)(push|apply|helm|aws|gcloud|az|vercel|netlify|flyctl|heroku|wrangler|supabase|psql|mysql|ssh|scp|rsync|curl|wget|gh|sentry-cli|docker\s+(?:push|login))(?![A-Za-z0-9])/i;
// -> the word that gives it away, or null
export function writeWord(text) {
  const t = String(text ?? '').replace(/["'\\]/g, '');
  const m = WRITE_ANY.exec(t) || WRITE_WORD.exec(t);
  return m ? m[1].toLowerCase() : null;
}
// Tools whose job is to check code: tests, types, lint, format, build.
const TOOLS = new Set(['pnpm', 'npm', 'yarn', 'bun', 'node', 'deno', 'vitest', 'jest', 'playwright', 'tsc', 'eslint', 'biome', 'prettier', 'turbo', 'nx', 'pytest', 'python', 'python3', 'ruff', 'mypy', 'black', 'flake8', 'pyright', 'uv', 'poetry', 'tox', 'go', 'golangci-lint', 'cargo', 'bundle', 'rspec', 'rubocop', 'mvn', 'gradle', './gradlew', 'dotnet', 'phpunit', 'composer', 'mix', 'swift']);
// These fetch and run a package by name: shown first.
const FETCHERS = /^(?:npx|bunx|pnpx|uvx|pipx)\b|^(?:pnpm|yarn)\s+(?:dlx|create)\b|^npm\s+(?:exec|x|init|create)\b|^bun\s+(?:x|create)\b/;
// These run whatever comes next: what comes next has to be a tool on the list.
const WRAPPERS = /^(?:(?:pnpm|yarn)\s+exec|bundle\s+exec|poetry\s+run|uv\s+run|pipenv\s+run)\s+(?:--\s+)?/;
// Code given on the command line is a script of its own: shown first.
const INLINE = /^(?:node|deno|bun|python3?|go|dotnet)\b.*\s(?:-e|-c|-p|--eval|--print)(?:[\s=]|$)/;
// Installs for the whole machine write outside this folder.
const GLOBAL = /\s(?:-g|--global)(?:\s|$)|^(?:npm|pnpm|yarn|bun)\s+link\b/;
const SHELL_SYNTAX = /[|;<>`]|\$\(|\$\{|(?<!&)&(?!&)|\\$/;
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=\S*\s+/;
// Variables that change how output looks, not what runs.
const PLAIN_ENV = new Set(['CI', 'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR', 'TZ', 'LANG', 'LC_ALL', 'TERM']);

const hit = (table, texts) => {
  for (const [re, what] of table) {
    for (const t of texts) {
      const line = String(t).split('\n').find((l) => re.test(l));
      if (line) return { what, line: line.trim().slice(0, 300) };
    }
  }
  return null;
};

// f: { actions, log_read, conclusion, error_texts, excerpt, own_error, in_a_file, repro, sibling_failed, reran }
//    in_a_file: an error points at a file of the repository (a test, a type error, a lint rule)
//    actions: the check is a GitHub Actions job · log_read: its log was fetched
//    sibling_failed: another job of the same workflow run failed with an error of its own
//    reran: this job was already rerun in this run and is red again
// -> { class, evidence }
export function classify(f) {
  if (!f.actions) return { class: 'external', evidence: 'not a GitHub Actions job: its log is not read here' };
  if (!f.log_read) return { class: 'external', evidence: 'its log could not be read (expired, or no access)' };
  if (f.reran) return { class: 'code', evidence: 'red again after a rerun: not a passing failure' };
  const conclusion = String(f.conclusion || '').toLowerCase();
  if (CONCLUSION_INFRA[conclusion]) return { class: 'infra', evidence: CONCLUSION_INFRA[conclusion] };
  // An error in a file of the repo is the code's, whatever words its message holds
  // (a test that expects "401 Unauthorized" is not a missing secret).
  if (f.in_a_file) return { class: 'code', evidence: 'the job reported errors in files of the repository' };
  const texts = f.own_error ? f.error_texts : [...(f.error_texts || []), f.excerpt || ''];
  const config = hit(CONFIG, texts);
  if (config) return { class: 'config', evidence: `${config.what}: ${config.line}` };
  const infra = hit(INFRA, texts);
  if (infra) return { class: 'infra', evidence: `${infra.what}: ${infra.line}` };
  if (!f.own_error && f.repro !== 'run' && f.sibling_failed) return { class: 'derived', evidence: 'it reports nothing but its exit code, and another job of the same run failed: it follows that one' };
  return { class: 'code', evidence: f.own_error ? 'the job reported errors of its own' : 'the command exited red and nothing points at the runner or at a secret' };
}

// A segment without its leading VAR=value words. -> { seg, sets: the first variable that is not a plain one }
function strip(raw) {
  let seg = raw.trim();
  let sets = null;
  for (let m = ASSIGN.exec(seg); m; m = ASSIGN.exec(seg)) {
    if (!PLAIN_ENV.has(m[1])) sets ||= m[1];
    seg = seg.slice(m[0].length);
  }
  return { seg, sets };
}
// The package script a segment runs, when it runs one: `pnpm test`, `npm run lint`, `yarn build`.
const scriptName = (seg) => {
  const m = /^(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/.exec(seg);
  return m && !['run', 'exec', 'install', 'i', 'ci', 'add', 'dlx', 'x'].includes(m[1]) ? m[1] : null;
};

// script: the lines of the failed step · uses: the step is an action
// scripts: the `scripts` of package.json at the head · mapped: what `repro` in the config says for this job
// -> { repro, why, command }
export function shape(script, { uses = false, scripts = {}, mapped } = {}) {
  if (mapped === false) return { repro: 'never', why: 'the config says this job is not run here', command: null };
  if (typeof mapped === 'string' && mapped.trim()) return { repro: 'run', why: 'the command the config gives for this job', command: mapped.trim() };
  const lines = (script || []).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const command = lines.join('\n');
  if (uses) return { repro: 'never', why: 'the failed step is an action, not a command', command: null };
  if (!lines.length) return { repro: 'never', why: 'the log does not show the command that failed', command: null };
  const word = writeWord(command);
  if (word) return { repro: 'never', why: `it names \`${word}\`: a command that writes somewhere is never run here`, command };
  if (lines.length > 1) return { repro: 'ask', why: 'a script of several lines', command };
  if (SHELL_SYNTAX.test(command)) return { repro: 'ask', why: 'it uses a pipe, a redirect or a substitution', command };
  for (const raw of command.split('&&')) {
    const { seg, sets } = strip(raw);
    if (sets) return { repro: 'ask', why: `it sets \`${sets}\` for the command`, command };
    if (/^cd\s+[\w.@-][\w./@-]*$/.test(seg) && !seg.includes('..')) continue;
    if (FETCHERS.test(seg)) return { repro: 'ask', why: `\`${seg.split(/\s+/).slice(0, 2).join(' ')}\` fetches and runs a package`, command };
    if (GLOBAL.test(seg)) return { repro: 'ask', why: 'it installs or links for the whole machine', command };
    if (INLINE.test(seg)) return { repro: 'ask', why: 'it runs code given on the command line', command };
    // `pnpm exec git …` runs git: the wrapper is not what is being run.
    const inner = seg.replace(WRAPPERS, '');
    for (const tool of new Set([seg.split(/\s+/)[0], inner.split(/\s+/)[0]])) if (!TOOLS.has(tool)) return { repro: 'ask', why: `\`${tool}\` is not on the list of tools that only check code`, command };
    const name = scriptName(seg);
    const body = name && typeof scripts?.[name] === 'string' ? scripts[name] : null;
    const inBody = body && writeWord(body);
    if (inBody) return { repro: 'never', why: `the package script \`${name}\` names \`${inBody}\`: a command that writes somewhere is never run here`, command };
  }
  return { repro: 'run', why: 'one line of tools that check code', command };
}

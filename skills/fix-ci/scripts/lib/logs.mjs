// What a failed GitHub Actions job said, cut down to what a fix needs.
//
// A job log is long (a failed test shard is easily 1,500 lines) and nearly
// all of it is setup. The failure is the command the runner ran, the errors
// it reported, and a few lines around the first of them. Everything here is
// pure: text in, facts out.

import { createHash } from 'node:crypto';

export const EXCERPT_LINES = 60;
export const EXCERPT_LINES_WITH_ERRORS = 25;
export const LINE_CHARS = 300;
export const MAX_ERRORS = 12;
const MESSAGE_CHARS = 400;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const STAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
// `gh run view --log` puts the job and the step in front of every line.
const PREFIX = /^[^\t\n]*\t[^\t\n]*\t(?=\uFEFF?\d{4}-\d\d-\d\dT)/;
const EXIT_ONLY = /^Process completed with exit code \d+\.?$/;
const GROUP_RUN = '##[group]Run ';
const ERROR = '##[error]';

// One log, as lines without timestamps, prefixes and colour codes.
export const clean = (text) => String(text ?? '').replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(PREFIX, '').replace(STAMP, '').replace(ANSI, '').replace(/\uFEFF/g, ''));

const isExitOnly = (s) => EXIT_ONLY.test(String(s).trim());
const firstLineOf = (s) => String(s ?? '').split('\n').find((l) => l.trim()) || '';
const capLine = (l) => (l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}…` : l);

// The group a step opens: `##[group]Run <first line>`, then the script again
// line by line, then `shell: …` when it is a command. An action has `with:`
// and no shell line.
function stepAt(lines, g) {
  const head = lines[g].slice(GROUP_RUN.length).trim();
  const script = [];
  let shell = false;
  for (let i = g + 1; i < lines.length && i < g + 400; i++) {
    const l = lines[i];
    if (l.startsWith('##[endgroup]') || l.startsWith(GROUP_RUN)) break;
    if (/^shell: /.test(l)) {
      shell = true;
      break;
    }
    if (/^(with|env):\s*$/.test(l)) break;
    script.push(l);
  }
  return shell ? { script: script.length ? script : [head], uses: false } : { script: [head], uses: true };
}

// lines: clean(log). annotations: GitHub's check-run annotations, or [].
// -> { command, script, uses, errors, more_errors, own_error, excerpt }
//    command: the script as one string, null when the log shows no step
//    own_error: the job reported something besides its exit code
export function cut(lines, annotations = []) {
  const errorAt = [];
  lines.forEach((l, i) => {
    if (l.startsWith(ERROR)) errorAt.push(i);
  });
  const real = errorAt.filter((i) => !isExitOnly(lines[i].slice(ERROR.length)));
  const firstError = errorAt[0] ?? lines.length;
  let g = -1;
  for (let i = Math.min(firstError, lines.length - 1); i >= 0; i--) {
    if (lines[i].startsWith(GROUP_RUN)) {
      g = i;
      break;
    }
  }
  const step = g >= 0 ? stepAt(lines, g) : null;

  const fromNotes = (Array.isArray(annotations) ? annotations : [])
    .filter((a) => a && String(a.annotation_level || 'failure') === 'failure' && !isExitOnly(a.message) && a.path !== '.github')
    .map((a) => ({ file: a.path || null, line: a.start_line ?? null, title: String(a.title || '').slice(0, LINE_CHARS), message: String(a.message || '').slice(0, MESSAGE_CHARS) }));
  const fromLog = real.map((i) => ({ file: null, line: null, title: '', message: lines[i].slice(ERROR.length).slice(0, MESSAGE_CHARS) }));
  const all = fromNotes.length ? fromNotes : fromLog;

  // Around the first errors; without any, the end of the failed step.
  const keep = new Set();
  const want = all.length ? EXCERPT_LINES_WITH_ERRORS : EXCERPT_LINES;
  const anchors = (real.length ? real : errorAt).slice(0, 3);
  if (anchors.length) {
    const before = Math.max(4, Math.floor(want / anchors.length) - 3);
    for (const i of anchors) for (let k = Math.max(g + 1, i - before, 0); k <= Math.min(lines.length - 1, i + 2); k++) keep.add(k);
  } else {
    let end = lines.length;
    for (let i = g + 1; g >= 0 && i < lines.length; i++) {
      if (lines[i].startsWith(GROUP_RUN)) {
        end = i;
        break;
      }
    }
    for (let k = Math.max(g + 1, end - want, 0); k < end; k++) keep.add(k);
  }
  const picked = [...keep].sort((a, b) => a - b).filter((k) => lines[k].trim() && !lines[k].startsWith('##[endgroup]')).slice(-want);
  const excerpt = [];
  picked.forEach((k, n) => {
    if (n && k !== picked[n - 1] + 1) excerpt.push('…');
    excerpt.push(capLine(lines[k]));
  });

  return {
    command: step ? step.script.join('\n') : null,
    script: step ? step.script : [],
    uses: step ? step.uses : false,
    errors: all.slice(0, MAX_ERRORS),
    more_errors: Math.max(0, all.length - MAX_ERRORS),
    own_error: all.length > 0,
    excerpt: excerpt.join('\n'),
  };
}

// What changes from run to run and says nothing about the cause.
const steady = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, '#')
    .replace(/\d+(?:\.\d+)?\s*(?:ms|s|m|kb|mb)\b/g, 'T')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
// A command is kept as it is, but for which shard it ran: `pnpm -F app1 test` and `pnpm -F app2 test` are two commands.
const steadyCommand = (s) => String(s ?? '').replace(/--shard[= ]\d+\/\d+/g, '--shard').replace(/\s+/g, ' ').trim();

// Two failed jobs with one signature are one failure (matrix legs, shards that hit the same test).
export function signature(command, errors) {
  const lines = (errors || []).map((e) => steady(`${e.file || ''} ${e.title || firstLineOf(e.message)}`)).sort();
  return createHash('sha1').update(JSON.stringify([steadyCommand(command), [...new Set(lines)]])).digest('hex').slice(0, 12);
}

// What a local run's output is searched for, to tell "red for the reason CI
// gave" from "red for another reason". A file name, or the first line of an
// error when it is long enough to mean something.
export function needles(errors) {
  const out = new Set();
  for (const e of errors || []) {
    if (e.file) out.add(e.file.split('/').pop());
    const first = firstLineOf(e.message).trim();
    if (first.length >= 16) out.add(first.slice(0, 80));
  }
  return [...out].filter((n) => n.length >= 4);
}

// One line of a failure for a log or for Jev: the first error, without paths that could carry a name.
export const headline = (errors) => {
  const e = (errors || [])[0];
  return e ? `${e.title ? `${e.title}: ` : ''}${firstLineOf(e.message)}`.replace(/\s+/g, ' ').trim().slice(0, LINE_CHARS) : '';
};

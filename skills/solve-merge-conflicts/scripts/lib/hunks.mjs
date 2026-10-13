// Text work on one conflicted file, with no git and no disk.
//
// The script never reads the markers git left in the working file. It builds
// its own conflicted copy from the three versions of the file (`git merge-file
// --zdiff3`, labels `pr`, `origin`, `base`, a marker longer than any marker-like
// line in the file), parses that copy here into plain text and hunks, and
// writes the file back from the copy plus one resolution per hunk. So which
// hunk became what is a fact, not a report.

const run = (c, n) => c.repeat(n);

// A marker length no line of these texts can be mistaken for.
export function markerSize(texts) {
  let longest = 0;
  for (const t of texts) for (const l of String(t ?? '').split('\n')) longest = Math.max(longest, /^(<+|>+|=+|\|+)/.exec(l)?.[0].length || 0);
  return Math.max(7, longest + 1);
}

// -> [{ type: 'text', lines } | { type: 'hunk', id, line, pr: [], origin: [], base: [] }]
// `line` is where the hunk starts in the conflicted copy, 1-based.
export function parse(text, size = 7) {
  const open = `${run('<', size)} pr`;
  const mid = `${run('|', size)} origin`;
  const sep = run('=', size);
  const close = `${run('>', size)} base`;
  const segments = [];
  let cur = { type: 'text', lines: [] };
  let part = null;
  let n = 0;
  String(text).split('\n').forEach((raw, i) => {
    const l = raw.replace(/\r$/, '');
    if (!part && l === open) {
      segments.push(cur);
      cur = { type: 'hunk', id: ++n, line: i + 1, pr: [], origin: [], base: [] };
      part = 'pr';
    } else if (part === 'pr' && l === mid) part = 'origin';
    else if ((part === 'pr' || part === 'origin') && l === sep) part = 'base';
    else if (part === 'base' && l === close) {
      segments.push(cur);
      cur = { type: 'text', lines: [] };
      part = null;
    } else if (part) cur[part].push(raw);
    else cur.lines.push(raw);
  });
  if (part) throw new Error('a conflict in this file never closes');
  segments.push(cur);
  return segments;
}

export const hunksOf = (segments) => segments.filter((s) => s.type === 'hunk');
export const textOf = (lines) => (lines.length ? `${lines.join('\n')}\n` : '');

// The lines a resolution puts where the hunk was.
// r: { kind: both|combined|pr|base, first?: pr|base, text? }
export function resolutionLines(hunk, r) {
  if (r.kind === 'pr') return hunk.pr;
  if (r.kind === 'base') return hunk.base;
  if (r.kind === 'both') return r.first === 'base' ? [...hunk.base, ...hunk.pr] : [...hunk.pr, ...hunk.base];
  if (r.kind === 'combined') {
    if (r.text === '') return [];
    // A file with Windows line endings keeps them in the lines written into it.
    const crlf = [...hunk.pr, ...hunk.base, ...hunk.origin].some((l) => l.endsWith('\r'));
    return String(r.text).replace(/\r?\n$/, '').split('\n').map((l) => (crlf ? `${l.replace(/\r$/, '')}\r` : l));
  }
  throw new Error(`not a way to resolve a hunk: ${r.kind}`);
}

// The file, with every resolved hunk written out and every other one still marked.
// resolutions: { "<hunk id>": r }
export function render(segments, resolutions, size = 7) {
  const out = [];
  for (const s of segments) {
    if (s.type === 'text') out.push(...s.lines);
    else if (resolutions[s.id]) out.push(...resolutionLines(s, resolutions[s.id]));
    else out.push(`${run('<', size)} pr`, ...s.pr, `${run('|', size)} origin`, ...s.origin, run('=', size), ...s.base, `${run('>', size)} base`);
  }
  return out.join('\n');
}

// Names and numbers: what a line is made of once punctuation and spacing are gone.
const TOKEN = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?/g;
const tokens = (lines) => new Set(lines.join('\n').match(TOKEN) || []);
const squeezed = (lines) => lines.join('').replace(/\s+/g, '');
export const sameButWhitespace = (a, b) => squeezed(a) === squeezed(b);

// What each side added to the lines both started from, and no longer is in `lines`.
export function missingTokens(hunk, lines) {
  const origin = tokens(hunk.origin);
  const have = tokens(lines);
  const missing = new Set();
  for (const side of [hunk.pr, hunk.base]) for (const t of tokens(side)) if (!origin.has(t) && !have.has(t)) missing.add(t);
  return [...missing].sort();
}

// Lines that say something: not blank, not a lone bracket.
const meaningful = (lines) => new Set(lines.map((l) => l.trim()).filter((l) => l.length > 3 && /[A-Za-z0-9]/.test(l)));
// How much of the shorter side's lines the other side wrote too, 0 to 1.
export function overlap(hunk) {
  const [a, b] = [meaningful(hunk.pr), meaningful(hunk.base)];
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const l of a) if (b.has(l)) shared += 1;
  return shared / Math.min(a.size, b.size);
}
export const SAME_LINES = 0.5;
// True when every line of `dropped` is in `kept` as well. Every line counts
// here, however short: `i++` is a change.
const whole = (lines) => lines.map((l) => l.replace(/\s+/g, '')).filter(Boolean);
const within = (dropped, kept) => {
  const k = new Set(whole(kept));
  return whole(dropped).every((l) => k.has(l));
};
// Lines with no name and no number in them (`});`, `else {`… without the
// word) that a side added and `lines` has fewer of than that side wrote.
export function missingMarks(hunk, lines) {
  const marks = (ls) => {
    const m = new Map();
    for (const l of whole(ls)) if (!/[A-Za-z0-9_$]/.test(l)) m.set(l, (m.get(l) || 0) + 1);
    return m;
  };
  const [origin, have] = [marks(hunk.origin), marks(lines)];
  const missing = new Set();
  for (const side of [hunk.pr, hunk.base]) for (const [l, n] of marks(side)) if (n > (origin.get(l) || 0) && (have.get(l) || 0) < n) missing.add(l);
  return [...missing].sort();
}

// Why this resolution needs the user's answer, or null when the script can
// show that nothing either side wrote is lost and nothing is written twice.
export function hunkAsk(hunk, r) {
  const fresh = !hunk.origin.some((l) => l.trim());
  if (r.kind === 'both') {
    // Both sides rewrote lines that were already there: writing both keeps two versions of them.
    if (!fresh) return 'both sides changed the same lines, so writing both keeps two versions of them';
    // Two versions of the same new code, as when one branch was built on an earlier copy of the other.
    return overlap(hunk) >= SAME_LINES ? 'the two sides wrote largely the same lines here, so writing both repeats them' : null;
  }
  if (r.kind === 'combined') {
    const lines = resolutionLines(hunk, r);
    const missing = [...missingTokens(hunk, lines), ...missingMarks(hunk, lines)];
    return missing.length ? `the combined text leaves out ${missing.slice(0, 12).map((t) => `\`${t}\``).join(', ')}${missing.length > 12 ? ` and ${missing.length - 12} more` : ''}, which one side added` : null;
  }
  const [kept, dropped, name] = r.kind === 'pr' ? [hunk.pr, hunk.base, 'the base'] : [hunk.base, hunk.pr, 'the pull request'];
  // Nothing is lost when the two differ only by spacing, or when both only added lines and the kept side has all of the other's.
  if (sameButWhitespace(kept, dropped) || (fresh && within(dropped, kept))) return null;
  return `what ${name} did to these lines is dropped`;
}

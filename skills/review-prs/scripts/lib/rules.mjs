// What counts as a finding. Reviewers propose; these rules decide, in a fixed
// order: citation, already raised, duplicates, refutation, nit budget. Then
// the verdict is computed from what is left.
//
// The citation check proves the quoted line exists at the PR head. It does not
// prove the reading of it is right.

export const WINDOW = 3;
// Shorter quotes ("return", "} else {") occur everywhere and prove nothing,
// unless the quote is a whole line.
export const MIN_QUOTE = 12;
export const SEVERITIES = ['bug', 'risk', 'nit', 'q'];
export const VERDICTS = ['blocking', 'comments', 'clean'];
export const DROP_RULES = ['citation', 'already_raised', 'refuted', 'nit_budget', 'not_actionable'];
export const CAPS = { problem: 240, fix: 240, quote: 300 };
export const MAX_NITS = 5;

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// Security is never compressed, cut by a budget, or dropped on a refuter's word.
export const isSecurity = (f) => f.lens === 'security' || /^\s*security\b/i.test(f.problem || '');
const RANK = { bug: 0, risk: 1, q: 2, nit: 3 };
const rank = (f) => (isSecurity(f) ? -1 : RANK[f.severity] ?? 9);

// f: { file, line, quote, ... }  ctx: { files: parsePatch(), headText(file) -> string|null }
// -> f + { verified, in_diff, problem_with? }. `line` is moved to where the
// quote really starts when the reviewer was off by a few lines.
export function checkCitation(f, { files, headText }) {
  const fail = (why) => ({ ...f, verified: false, in_diff: false, problem_with: why });
  if (!f || typeof f.file !== 'string' || !f.file) return fail('no file');
  const entry = files.find((x) => x.file === f.file);
  if (!entry) return fail('file is not in this PR');
  if (entry.deleted || entry.binary) return fail('file is deleted or binary at the PR head');
  const text = headText(f.file);
  if (text == null) return fail('file could not be read at the PR head');
  const lines = text.split('\n');
  if (!Number.isInteger(f.line) || f.line < 1 || f.line > lines.length) return fail(`line out of range (file has ${lines.length} lines)`);
  const quote = squash(f.quote);
  const lo = Math.max(1, f.line - WINDOW);
  const hi = Math.min(lines.length, f.line + WINDOW);
  const near = [];
  for (let n = lo; n <= hi; n++) near.push({ n, text: squash(lines[n - 1]) });
  const whole = near.find((l) => l.text && l.text === quote);
  if (!quote || (quote.length < MIN_QUOTE && !whole)) return fail(`quote is missing or too short to check (at least ${MIN_QUOTE} characters, or one whole line)`);
  if (!squash(near.map((l) => l.text).join(' ')).includes(quote)) return fail(`quote not found within ${WINDOW} lines of line ${f.line}`);
  // Where the quote starts: the cited line if it holds it, else the nearest that does.
  const holds = (l) => l.text && (l.text.includes(quote) || quote.startsWith(l.text));
  const at = [...near].sort((a, b) => Math.abs(a.n - f.line) - Math.abs(b.n - f.line)).find(holds);
  const line = at ? at.n : f.line;
  return { ...f, line, verified: true, in_diff: entry.lines.has(line) };
}

// findings: checked, each with a stable `id`. refutations: [{ id, refuted, reason, cite }]
// where `cite` went through checkCitation. existing: [{ path, line }] review
// comments already on the PR.
// -> { kept, outside_diff, dropped: { rule: n }, dropped_items }
export function applyRules({ findings = [], refutations = [], existing = [], maxNits = MAX_NITS }) {
  const dropped = Object.fromEntries(DROP_RULES.map((r) => [r, 0]));
  const dropped_items = [];
  const drop = (f, rule, why) => {
    dropped[rule] += 1;
    dropped_items.push({ id: f.id, rule, why, file: f.file, line: f.line });
  };

  let live = [];
  for (const f of findings) {
    if (!f.verified) drop(f, 'citation', f.problem_with);
    else if (existing.some((c) => c.path === f.file && Number.isInteger(c.line) && Math.abs(c.line - f.line) <= WINDOW)) drop(f, 'already_raised', 'a review comment already sits on these lines');
    else live.push(f);
  }

  // Refutation comes before merging so each finding is judged alone. A bug
  // goes only when the refuter says so and points at a line that checks out.
  const byId = new Map(refutations.map((r) => [r.id, r]));
  live = live.flatMap((f) => {
    const r = byId.get(f.id);
    if (!r || r.refuted !== true || f.severity !== 'bug') return [f];
    if (!r.cite?.verified) return [{ ...f, refuter_note: 'refuter disagreed without a checkable citation' }];
    if (isSecurity(f)) return [{ ...f, refuter_note: `refuter disagrees: ${r.reason}` }];
    drop(f, 'refuted', r.reason);
    return [];
  });

  // One comment per place: findings within a few lines of each other in one
  // file are merged. Nothing is lost: the others ride along in `also`.
  live.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || rank(a) - rank(b));
  const merged = [];
  let duplicates = 0;
  for (const f of live) {
    const prev = merged[merged.length - 1];
    if (prev && prev.file === f.file && Math.abs(f.line - prev.line) <= WINDOW && prev.in_diff === f.in_diff) {
      const [main, other] = rank(f) < rank(prev) ? [f, prev] : [prev, f];
      merged[merged.length - 1] = {
        ...main,
        lenses: [...new Set([...(prev.lenses || [prev.lens]), f.lens])],
        also: [...(main.also || []), ...(other.also || []), { lens: other.lens, severity: other.severity, problem: other.problem, fix: other.fix }],
      };
      duplicates += 1;
    } else merged.push({ ...f, lenses: [f.lens] });
  }

  // Nits past the budget are counted, not shown. Nothing else is ever cut.
  let nits = 0;
  const kept = [];
  for (const f of merged) {
    if (f.severity === 'nit' && !isSecurity(f) && ++nits > maxNits) drop(f, 'nit_budget', `more than ${maxNits} nits`);
    else kept.push(f);
  }
  kept.sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file) || a.line - b.line);
  return { kept: kept.filter((f) => f.in_diff), outside_diff: kept.filter((f) => !f.in_diff), dropped, merged: duplicates, dropped_items };
}

// partial: reasons something was not reviewed ([] when everything was).
export function verdict({ kept = [], outside_diff = [], partial = [] }) {
  const all = [...kept, ...outside_diff];
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, all.filter((f) => f.severity === s).length]));
  counts.security = all.filter(isSecurity).length;
  const v = counts.bug || counts.security ? 'blocking' : all.length ? 'comments' : 'clean';
  return { verdict: v, partial: partial.length > 0, partial_reasons: partial, counts };
}

// Length caps (references/report-style.md). Over-long is reported, never cut.
export function overCaps(findings) {
  const over = [];
  for (const f of findings) {
    if (isSecurity(f)) continue;
    for (const [k, cap] of Object.entries(CAPS)) if (String(f[k] || '').length > cap) over.push({ id: f.id, field: k, len: f[k].length, cap });
  }
  return over;
}

// The blind comparison. The critic who compares is shown two pictures called X
// and Y and is never told which is newer. This file decides which is which and
// keeps the key; only the harness can turn "X" back into "before" or "after".

// pairs: [{move, viewport, before, after}] -> { sheet, key }
// sheet goes to the critic: [{pair, viewport, X, Y}] with the paths the harness
// copied the pictures to. key stays in run.json.
export function assign(pairs, rand = Math.random) {
  const sheet = [];
  const key = {};
  pairs.forEach((p, n) => {
    const pair = `p${n + 1}`;
    const xIsAfter = rand() < 0.5;
    key[pair] = { move: p.move, viewport: p.viewport, X: xIsAfter ? 'after' : 'before', Y: xIsAfter ? 'before' : 'after', before: p.before, after: p.after };
    sheet.push({ pair, viewport: p.viewport, X: `${pair}-X.png`, Y: `${pair}-Y.png` });
  });
  return { sheet, key };
}

const text = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// answers: [{pair, prefers: X|Y|same, x, y, broke?: {side: X|Y, what, where}}]
// (x and y: one line each on what that picture shows)
// -> one row per pair in the key: {pair, move, viewport, prefers: before|after|same|missing, broke, shows: {before, after}}
// "broke" counts only on the newer side and only with a place named: damage in
// the old picture is what the move fixed, and "feels off" is not a finding.
export function unblind(key, answers) {
  const by = new Map((Array.isArray(answers) ? answers : []).filter((a) => a && typeof a.pair === 'string').map((a) => [a.pair, a]));
  return Object.entries(key).map(([pair, k]) => {
    const a = by.get(pair);
    const prefers = a?.prefers === 'same' ? 'same' : a?.prefers === 'X' || a?.prefers === 'Y' ? k[a.prefers] : 'missing';
    const b = a?.broke;
    const broke = b && (b.side === 'X' || b.side === 'Y') && k[b.side] === 'after' && text(b.what, 200) && text(b.where, 120) ? { what: text(b.what, 200), where: text(b.where, 120) } : null;
    const shows = { [k.X]: text(a?.x, 200), [k.Y]: text(a?.y, 200) };
    return { pair, move: k.move, viewport: k.viewport, prefers, broke, shows: { before: shows.before, after: shows.after } };
  });
}

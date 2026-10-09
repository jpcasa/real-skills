// From the critic's issues to the moves a run may make. A move is one issue
// (or several on the same element), one impeccable command and one intent line.
// The critic proposes; this file checks, merges, ranks, cuts and decides what
// is preselected. Nothing here talks to a model.

// Refine keeps the visual identity. Shift changes the direction, so it is
// never preselected and never runs under --auto on the critic's word alone.
export const REFINE = ['polish', 'layout', 'typeset', 'clarify', 'distill', 'harden', 'adapt', 'optimize', 'onboard'];
export const SHIFT = ['bolder', 'quieter', 'colorize', 'animate', 'delight', 'overdrive'];
export const COMMANDS = [...REFINE, ...SHIFT];
export const kindOf = (command) => (REFINE.includes(command) ? 'refine' : SHIFT.includes(command) ? 'shift' : null);

export const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
// Rank order: what a script saw outranks what a model judged.
export const SOURCES = ['detector', 'audit', 'critique'];
export const MAX_MOVES = 6;
export const HARD_MAX_MOVES = 10;
export const SKIPPED_SHIFT = 'a direction change needs a yes: rerun without --auto, or pass --direction';

const line = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const rankOf = (m) => [SEVERITIES.indexOf(m.severity), SOURCES.indexOf(m.source) === -1 ? SOURCES.length : SOURCES.indexOf(m.source), m.order];
const byRank = (a, b) => {
  const [x, y] = [rankOf(a), rankOf(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

// issues: [{id, severity, element, problem, fix, command, alt?, source, files?, visual?}]
// -> { moves, cut, refused }. Moves come back in the order they run.
export function buildMoves(issues, { maxMoves = MAX_MOVES, direction = null, auto = false } = {}) {
  if (direction !== null && !kindOf(direction)) throw new Error(`${direction} is not a command a move can run: ${COMMANDS.join(', ')}`);
  const limit = Math.max(1, Math.min(HARD_MAX_MOVES, Number.isInteger(maxMoves) ? maxMoves : MAX_MOVES));
  const refused = [];
  const merged = new Map();
  (issues || []).forEach((raw, order) => {
    const id = line(raw?.id, 40) || `i${order + 1}`;
    const element = line(raw?.element, 120);
    const why = !kindOf(raw?.command) ? `${line(raw?.command, 40) || 'no command'} is not a command a move can run`
      : !SEVERITIES.includes(raw?.severity) ? `severity ${line(raw?.severity, 20) || 'missing'} is not one of ${SEVERITIES.join(', ')}`
      : !element ? 'no element named'
      : !line(raw?.problem) ? 'no problem stated'
      : null;
    if (why) return refused.push({ issue: id, why });
    const key = `${element.toLowerCase()}|${raw.command}`;
    const files = (Array.isArray(raw.files) ? raw.files : []).map((f) => line(f, 300)).filter(Boolean);
    const alt = kindOf(raw.alt) && raw.alt !== raw.command ? raw.alt : null;
    const had = merged.get(key);
    if (!had) {
      return merged.set(key, { issues: [id], severity: raw.severity, source: SOURCES.includes(raw.source) ? raw.source : 'critique', element, problem: line(raw.problem), intent: line(raw.fix), command: raw.command, alt, kind: kindOf(raw.command), files, visual: raw.visual !== false, order });
    }
    had.issues.push(id);
    const stronger = byRank({ severity: raw.severity, source: raw.source, order }, had) < 0;
    if (SEVERITIES.indexOf(raw.severity) < SEVERITIES.indexOf(had.severity)) had.severity = raw.severity;
    if (SOURCES.indexOf(raw.source) !== -1 && SOURCES.indexOf(raw.source) < SOURCES.indexOf(had.source)) had.source = raw.source;
    if (stronger) Object.assign(had, { problem: line(raw.problem), intent: line(raw.fix) || had.intent });
    had.files = [...new Set([...had.files, ...files])];
    had.visual ||= raw.visual !== false;
    had.alt ||= alt;
  });

  const all = [...merged.values()];
  if (direction) {
    const asked = all.filter((m) => m.command === direction);
    if (asked.length) asked.forEach((m) => (m.forced = true));
    else all.push({ issues: [], severity: 'P1', source: 'user', element: 'the whole screen', problem: `Asked for with --direction ${direction}`, intent: `Run ${direction} on the screen`, command: direction, alt: null, kind: kindOf(direction), files: [], visual: true, order: all.length, forced: true });
  }
  // What was asked for is never cut; the rest fill what is left, best first.
  const forced = all.filter((m) => m.forced).sort(byRank);
  const rest = all.filter((m) => !m.forced).sort(byRank);
  const room = Math.max(0, limit - forced.length);
  const cut = rest.slice(room).map(({ order, ...m }) => ({ ...m, why: `over the limit of ${limit} moves` }));
  const chosen = [...forced, ...rest.slice(0, room)].sort(byRank);

  // A rejected direction change must cost nothing that came before it.
  const ordered = [...chosen.filter((m) => m.kind === 'refine'), ...chosen.filter((m) => m.kind === 'shift')];
  const moves = ordered.map(({ order, ...m }, n) => {
    const move = { id: `m${n + 1}`, ...m, selected: m.kind === 'refine' || m.forced === true };
    if (auto && !move.selected) move.skipped = SKIPPED_SHIFT;
    return move;
  });
  return { moves, cut, refused };
}

// After a move changed kind or command: refine first, then shift, in the order
// they already had, numbered again. Selection follows the same rule as above
// unless something already decided it (`decided`: the user, --direction or Jev).
export function reorder(moves, { auto = false } = {}) {
  const ordered = [...moves.filter((m) => m.kind === 'refine'), ...moves.filter((m) => m.kind === 'shift')];
  return ordered.map((m, n) => {
    const move = { ...m, id: `m${n + 1}` };
    delete move.skipped;
    if (!move.decided) move.selected = move.kind === 'refine' || move.forced === true;
    if (auto && !move.selected && move.kind === 'shift' && !move.cut_by) move.skipped = SKIPPED_SHIFT;
    return move;
  });
}

// Jev questions for /improve-design. Jev reads text only: the critic's issue
// and intent lines, command names, file paths, detector counts, heuristic
// names with their scores, and one line per picture on what it shows. Never a
// screenshot, the diff, source text or a query string. Everything is scrubbed
// again here before it leaves.

import * as C from './calibration.mjs';
import { scrub } from './scrub.mjs';

export const SKILL = 'improve-design';
export const THRESHOLDS = {
  move_worth_doing: 0.3, // below: cut the move from the plan
  changes_visual_identity: 0.6, // at or above: a direction change, whatever its command says
  direction_change_warranted: 0.8, // at or above: a direction change is preselected, and runs under --auto
  alternative_fits_better: 0.7, // at or above: use the critic's second-choice command
  is_improvement: 0.4, // below: drop the move
  harms_another_state: 0.7, // at or above: drop the move
};
// acts_when: which side of the threshold changes anything. unsafe: the error
// that must never happen (fn = saying no when the answer was yes, fp = the reverse).
export const META = {
  move_worth_doing: { acts_when: 'lt', unsafe: 'fn' },
  changes_visual_identity: { acts_when: 'gte', unsafe: 'fn' },
  direction_change_warranted: { acts_when: 'gte', unsafe: 'fp' },
  alternative_fits_better: { acts_when: 'gte', unsafe: null },
  is_improvement: { acts_when: 'lt', unsafe: 'fp' },
  harms_another_state: { acts_when: 'gte', unsafe: 'fn' },
};
export const PLAN = ['move_worth_doing', 'changes_visual_identity', 'direction_change_warranted', 'alternative_fits_better'];
export const COMPARE = ['is_improvement', 'harms_another_state'];
// No outcome data yet: logged, never deciding. IMPROVE_DESIGN_TEST_CALIBRATED is for tests.
export const UNCALIBRATED = new Set(Object.keys(THRESHOLDS));
const forTests = (id) => (process.env.IMPROVE_DESIGN_TEST_CALIBRATED || '').split(',').includes(id);
export const calibrated = (id) => !UNCALIBRATED.has(id) || forTests(id) || C.isOn(SKILL, id);
export const thr = (id) => C.threshold(SKILL, id, THRESHOLDS[id]);
// One decision in ten of a question switched on by /calibrate is not acted on, and marked.
export const spot = (id, caseId) => UNCALIBRATED.has(id) && !forTests(id) && C.isOn(SKILL, id) && C.spotCheck(caseId);

export const MAX_MOVES = 10;
const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
// A query string can carry a token or a person's id.
export const clean = (s, n = 300) => scrub(String(s ?? '').replace(/\?[^\s"'<>)]*/g, '')).replace(/\s+/g, ' ').trim().slice(0, n);
export const moveLine = (m) => clean(`${m.command} on ${m.element}: ${m.problem}`, 300);

// screen: { route, lowest: ["<heuristic name> 1/4", …] }
// moves:  the planned moves, before anything was selected
export function buildPlan(screen, moves) {
  const list = moves.slice(0, MAX_MOVES);
  const state = {
    screen: { route: clean(screen.route, 200), weakest: (screen.lowest || []).slice(0, 4).map((l) => clean(l, 80)) },
    moves: list.map((m) => ({ element: clean(m.element, 120), problem: clean(m.problem), intent: clean(m.intent), command: m.command, alternative: m.alt || null, severity: m.severity, found_by: m.source, files: (m.files || []).slice(0, 10).map((f) => clean(f, 200)) })),
  };
  const questions = {};
  list.forEach((m, n) => {
    questions[`worth__${n}`] = noul(
      `Would fixing \`moves[${n}].problem\` make this screen clearly better for the people who use it?`,
      'The problem gets in the way of a task, hides something people need, or makes the screen hard to read or use.',
      'It is a matter of taste, nobody using the screen would notice, or the fix costs more clarity than it adds.',
    );
    questions[`identity__${n}`] = noul(
      `Would carrying out \`moves[${n}].intent\` change how the product looks and feels as a whole, rather than tidy what is already there?`,
      'It changes the palette, the typeface, the mood, the amount of motion or the personality of the screen.',
      'It fixes spacing, alignment, hierarchy, wording, states or accessibility inside the look the screen already has.',
    );
    questions[`warranted__${n}`] = noul(
      `Going by \`screen.weakest\` and \`moves[${n}].problem\`, is the look of this screen itself the problem, so that a change of direction is needed and tidying would not be enough?`,
      'The problem is that the screen is bland, loud, lifeless or generic as a whole, and no local fix would change that.',
      'The problem is local, or the screen works as it is and the change would be a matter of preference.',
    );
    if (m.alt) {
      questions[`alt__${n}`] = noul(
        `Is \`moves[${n}].alternative\` a better kind of fix for \`moves[${n}].problem\` than \`moves[${n}].command\`?`,
        'The alternative names what is actually wrong, and the chosen command would treat a symptom.',
        'The chosen command fits the problem, or both would do the same work.',
      );
    }
  });
  return { state, questions, moves: list };
}

// move:  the move as planned
// views: [{viewport, before, after}] — one line each on what the picture shows, in the critic's words
// detector: { fixed: n, new: n }
export function buildCompare(move, views, detector) {
  const state = {
    move: { element: clean(move.element, 120), problem: clean(move.problem), intent: clean(move.intent), command: move.command },
    views: views.slice(0, 4).map((v) => ({ viewport: v.viewport, before: clean(v.before, 200), after: clean(v.after, 200) })),
    detector: { fixed: detector?.fixed ?? 0, new: detector?.new ?? 0 },
  };
  const questions = {
    is_improvement: noul(
      'Going by `move.problem` and what `views` say the screen looked like before and after, is the after version better for the people using the screen?',
      'After, the named problem is gone or clearly smaller, and what is described is easier to read or use.',
      'After, the problem is still there, something is harder to read or use, or the two are described as the same.',
    ),
    harms_another_state: noul(
      'Does anything in the `after` lines of `views`, or in `detector.new`, say the change damaged something other than what it set out to fix?',
      'An after line names text that wraps or is cut off, an element that moved or vanished, lost contrast, or a layout that breaks at one viewport.',
      'The after lines describe only the intended change, at every viewport.',
    ),
  };
  return { state, questions };
}

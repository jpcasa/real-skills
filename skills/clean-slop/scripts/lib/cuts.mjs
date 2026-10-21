// What a cleanup removes beyond slop. Each hit is one question for the user,
// never a refusal: a guard can be dead code too, and only the user can say so.
// A line that reappears in another changed file (code moved into a shared
// helper) is not removed. Pure.

import { addedLines } from './flags.mjs';

// Code that guards something: input checks, error handling, auth, accessibility.
const NEVER_CUT = /\b(?:throw|catch|try|finally|raise|except|rescue|reject|assert\w*|validat\w*|sanitiz\w*|escape\w*|authori[sz]\w*|authenticat\w*|permission\w*|csrf|xss|timingSafeEqual|tabindex)\b|\.(?:safeParse|parse)\(|\berr\s*!=\s*nil\b|\bpanic!?\(|\baria-[\w-]+|\brole=|\balt=|\bstatus\(\s*4\d\d|\bredirect\(/i;
// An early exit is how most guards are written: `if (!req.user) return …`.
const GUARD_IF = /^(?:\}\s*else\s+)?if\b.*\)\s*\{?\s*(?:return|throw)\b/;
// Comments are slop candidates themselves: a removed comment is never a cut.
const COMMENT = /^(?:\/\/|\/\*|\*|#(?![[!])|<!--|--|;)/;
const PROSE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;
// Facts in prose: links, commands, code, warnings.
const FACT = /https?:\/\/|`[^`]+`|^```|\b(?:warning|caution|danger|important|must|never|do not|don't)\b|(?:^|\s)(?:npm|pnpm|yarn|npx|node|git|make|docker|curl|pip|cargo|go)\s+\w/i;

// changes: [{ file, before, after }], text or null when the file is not there on that side
// -> { flags: [{ id, flag, file, reason }], added, removed } — added/removed: non-blank lines
export function cutsOf(changes) {
  const flags = [];
  const addedBy = changes.map((c) => addedLines(c.before, c.after));
  const moved = new Set(addedBy.flat());
  let removed = 0;
  for (const { file, before, after } of changes) {
    const gone = addedLines(after, before);
    removed += gone.length;
    const prose = PROSE.test(file);
    const hit = gone.find((l) => !moved.has(l) && (prose ? FACT.test(l) : !COMMENT.test(l) && (NEVER_CUT.test(l) || GUARD_IF.test(l))));
    if (!hit) continue;
    const flag = prose ? 'doc_fact' : 'never_cut';
    const what = prose ? 'a link, command, code or warning' : 'a guard (validation, error handling, auth or accessibility)';
    flags.push({ id: `${flag}:${file}`, flag, file, reason: `removes ${what}: ${hit.slice(0, 120)}` });
  }
  const added = addedBy.flat().length;
  if (added > removed) flags.push({ id: 'grew:*', flag: 'grew', file: '*', reason: `adds ${added} lines and removes ${removed}: a cleanup should leave less code` });
  return { flags, added, removed };
}

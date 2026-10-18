// Pure plan rules for /create-plan: parse a plan file, parse a spec's
// Done-when list, and report every structural problem. No I/O.

export const MAX_TASKS = 8;
export const MAX_TASK_LINES = 8; // non-blank lines under a task heading
export const MAX_HEAD_LINES = 25; // non-blank lines before `## Tasks`
export const HEADERS = ['Spec', 'Goal', 'Verify'];
export const SECTIONS = ['Tasks', 'Execution'];
export const FIELDS = ['Files', 'Covers', 'Parallel', 'Review'];
export const STEPS = ['Run', 'Commit'];
export const RULES = ['missing_header', 'missing_section', 'missing_field', 'placeholder', 'parallel_overlap', 'uncovered', 'bad_covers', 'needs_review', 'over_cap'];

// Areas where one task's mistake is expensive: a task touching them is
// reviewed on its own. Code decides this; Jev may only add a task to it.
export const REVIEW = /schema|migrat|\brls\b|polic(y|ies)|auth(?!ors?\b)|login|session|permission|payment|billing|checkout|stripe|\bpii\b|personal.?data|delet|purge|irreversib|public.?api|shared.?interface|contract|subsystem/i;
// TBD/TODO only in capitals: `src/features/todo/` is a real path.
const PLACEHOLDER = /\bTBD\b|\bTODO\b|[Ss]imilar to [Tt]ask \d|[Aa]dd (appropriate )?error handling|[Hh]andle edge cases|\bas needed\.?$|\bfill in later\b/;

// `a/{b,c}.ts, d.ts (modify)` -> ['a/b.ts', 'a/c.ts', 'd.ts']
export function splitFiles(value) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts
    // Only a trailing note goes: `src/app/(auth)/page.tsx` is a Next.js route group, not a note.
    .map((p) => p.replace(/`/g, '').trim().replace(/\s+\([^)]*\)$/, '').trim())
    .filter((p) => p && p !== '—' && p !== '-')
    .flatMap(expand)
    .map((p) => p.replace(/^\.\//, ''));
}

// `src/{a,b}/{c,d}.ts` -> four paths: expand the first group, then recurse.
function expand(p) {
  const m = p.match(/^([^{]*)\{([^{}]*)\}(.*)$/);
  return m ? m[2].split(',').flatMap((x) => expand(`${m[1]}${x.trim()}${m[3]}`)) : [p];
}

const fieldsOf = (line) => {
  // `Covers: D1,D2 · Parallel: yes · Review: no` -> {Covers, Parallel, Review}
  const out = {};
  for (const part of line.split(/\s+·\s+/)) {
    const m = part.match(/^(?:-\s*\[[ x]\]\s*)?([A-Z][A-Za-z]*):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
};

export function parsePlan(text) {
  const plan = { header: {}, sections: [], head_lines: 0, tasks: [], lines: [] };
  let section = null;
  let task = null;
  text.split('\n').forEach((raw, i) => {
    const t = raw.trim();
    const n = i + 1;
    if (!t) return;
    plan.lines.push({ n, text: t });
    const h2 = t.match(/^##\s+(?!#)(.+)$/);
    if (h2) {
      section = h2[1].trim();
      plan.sections.push(section);
      task = null;
      return;
    }
    if (!plan.sections.includes('Tasks')) plan.head_lines++;
    if (!section) {
      const m = t.match(/^([A-Z][A-Za-z]*):\s*(.*)$/);
      if (m) plan.header[m[1]] = { value: m[2].trim(), n };
      return;
    }
    if (section !== 'Tasks') return;
    const h3 = t.match(/^###\s+Task\s+(\d+)\s*:?\s*(.*)$/i);
    if (h3) {
      task = { id: Number(h3[1]), name: h3[2].trim(), n, lines: 0, fields: {}, steps: [], files: [] };
      plan.tasks.push(task);
      return;
    }
    if (!task) return;
    task.lines++;
    if (/^- \[[ x]\]/.test(t)) {
      const body = t.replace(/^- \[[ x]\]\s*/, '');
      task.steps.push({ n, text: body });
      for (const [k, v] of Object.entries(fieldsOf(t))) if (STEPS.includes(k)) task.fields[k] ??= { value: v, n };
      return;
    }
    for (const [k, v] of Object.entries(fieldsOf(t))) task.fields[k] = { value: v, n };
  });
  for (const task of plan.tasks) task.files = task.fields.Files ? splitFiles(task.fields.Files.value) : [];
  return plan;
}

// Done-when items of a spec, in order: D1, D2, …
export function parseDoneWhen(text) {
  const out = [];
  let inside = false;
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (/^##\s+/.test(t)) inside = /^##\s+Done when\s*$/i.test(t);
    else if (inside && /^- \[[ x]\]/.test(t)) out.push(t.replace(/^- \[[ x]\]\s*/, ''));
  }
  return out;
}

// `D1,D3`, `D1–D3` and `D1-3` -> ['D1', 'D2', 'D3'] (or as written).
const covers = (task) => {
  const v = task.fields.Covers?.value || '';
  const out = [];
  for (const m of v.matchAll(/\bD(\d+)(?:\s*[–-]\s*D?(\d+))?\b/g)) {
    const [a, b] = [Number(m[1]), m[2] ? Number(m[2]) : Number(m[1])];
    for (let i = a; i <= Math.max(a, b); i++) out.push(`D${i}`);
  }
  return out;
};

export const needsReview = (files) => files.filter((f) => REVIEW.test(f));

export function lintPlan(plan, done = null) {
  const out = [];
  const add = (line, rule, text) => out.push({ line, rule, text });
  for (const h of HEADERS) if (!plan.header[h]?.value) add(0, 'missing_header', `Missing \`${h}: …\` before the first section.`);
  if (plan.header.Verify?.value && !/`[^`]+`/.test(plan.header.Verify.value)) add(plan.header.Verify.n, 'missing_header', 'Verify needs the exact command in backticks.');
  for (const s of SECTIONS) if (!plan.sections.includes(s)) add(0, 'missing_section', `Missing \`## ${s}\`.`);
  if (plan.head_lines > MAX_HEAD_LINES) add(0, 'over_cap', `${plan.head_lines} lines before \`## Tasks\`, cap ${MAX_HEAD_LINES}. Cut the file map.`);
  if (plan.tasks.length > MAX_TASKS) add(0, 'over_cap', `${plan.tasks.length} tasks, cap ${MAX_TASKS}. Merge, or one plan per spec slice.`);
  if (plan.sections.includes('Tasks') && !plan.tasks.length) add(0, 'missing_section', '`## Tasks` has no `### Task N: <name>`.');

  for (const t of plan.tasks) {
    const tag = `Task ${t.id}`;
    if (t.lines > MAX_TASK_LINES) add(t.n, 'over_cap', `${tag}: ${t.lines} lines, cap ${MAX_TASK_LINES}. Split it or cut steps.`);
    for (const f of [...FIELDS, ...STEPS]) if (!t.fields[f]) add(t.n, 'missing_field', `${tag}: missing \`${f}:\`.`);
    const run = t.fields.Run?.value;
    if (run !== undefined && !/`[^`]+`|\bVerify\b/.test(run)) add(t.fields.Run.n, 'missing_field', `${tag}: \`Run:\` needs a backticked command or \`Verify\`.`);
    if (t.fields.Files && !t.files.length) add(t.fields.Files.n, 'missing_field', `${tag}: \`Files:\` names no file.`);
    const hit = needsReview(t.files);
    if (hit.length && !/^yes\b/i.test(t.fields.Review?.value || '')) add(t.fields.Review?.n ?? t.n, 'needs_review', `${tag}: touches \`${hit[0]}\`; set \`Review: yes\`.`);
    for (const c of covers(t)) {
      const k = Number(c.slice(1));
      if (k < 1 || (done?.length && k > done.length)) add(t.fields.Covers.n, 'bad_covers', `${tag}: \`${c}\` is not in the spec${done?.length ? ` (it has D1–D${done.length})` : ''}.`);
    }
  }
  for (const l of plan.lines) if (PLACEHOLDER.test(l.text)) add(l.n, 'placeholder', `Placeholder: "${l.text.match(PLACEHOLDER)[0]}". Say exactly what to do.`);

  const parallel = plan.tasks.filter((t) => /^yes\b/i.test(t.fields.Parallel?.value || ''));
  for (let i = 0; i < parallel.length; i++) {
    for (const b of parallel.slice(i + 1)) {
      const shared = parallel[i].files.find((f) => b.files.includes(f));
      if (shared) add(b.n, 'parallel_overlap', `Tasks ${parallel[i].id} and ${b.id} both \`Parallel: yes\` and share \`${shared}\`. Order them.`);
    }
  }

  if (done && !done.length) add(0, 'uncovered', 'The spec has no `## Done when` checkbox items to cover. Fix the spec first.');
  if (done?.length) {
    const cited = new Set(plan.tasks.flatMap(covers));
    done.forEach((d, i) => {
      if (!cited.has(`D${i + 1}`)) add(0, 'uncovered', `Spec D${i + 1} has no task: "${d.slice(0, 80)}".`);
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

// Which tasks cover each Done-when item.
export function coverage(plan, done) {
  return Object.fromEntries(done.map((_, i) => [`D${i + 1}`, plan.tasks.filter((t) => covers(t).includes(`D${i + 1}`)).map((t) => t.id)]));
}

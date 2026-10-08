// The only SQL /qa-this will run: one read. The statement is checked on a copy
// with comments, string literals and quoted identifiers blanked out, so a
// keyword inside a literal is not a keyword and a comment cannot hide a second
// statement. When the two readings could differ, it refuses.
//
// This is a filter on text, not a sandbox. The database user behind the
// configured command should be read-only as well; setup says so.

export const ROW_LIMIT = 50;

const WRITES = /\b(insert|update|delete|merge|upsert|replace|drop|alter|create|truncate|grant|revoke|copy|call|execute|into|vacuum|reindex|refresh|lock|attach|detach|pragma|load|handler)\b/i;
const LOCKING = /\bfor\s+(no\s+key\s+update|key\s+share|share|update)\b/i;
const FUNCTIONS = /\b(pg_sleep\w*|sleep|benchmark|dblink\w*|lo_\w+|pg_read_\w+|pg_ls_\w+|pg_stat_file|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_advisory\w*|set_config|nextval|setval|load_file|xp_\w+|query_to_xml\w*|database_to_xml\w*)\s*\(/i;

// -> { text } with comments removed and literals blanked, or { problem }.
export function strip(sql) {
  const s = String(sql ?? '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const two = s.slice(i, i + 2);
    if (two === '--' || c === '#') {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl;
      out += ' ';
    } else if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < s.length && depth) {
        if (s.startsWith('/*', i)) (depth++, (i += 2));
        else if (s.startsWith('*/', i)) (depth--, (i += 2));
        else i++;
      }
      if (depth) return { problem: 'unterminated comment' };
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      // A backslash anywhere in a literal is read differently by different
      // databases, and one reading can end the literal early.
      let j = i + 1;
      for (;;) {
        if (j >= s.length) return { problem: 'unterminated quote' };
        if (s[j] === '\\') return { problem: 'backslash inside a quoted value' };
        if (s[j] === c) {
          if (s[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      out += c === "'" ? "''" : 'q';
      i = j + 1;
    } else if (c === '$') {
      const m = s.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (!m) {
        out += c;
        i++;
        continue;
      }
      const end = s.indexOf(m[0], i + m[0].length);
      if (end === -1) return { problem: 'unterminated dollar quote' };
      out += "''";
      i = end + m[0].length;
    } else {
      out += c;
      i++;
    }
  }
  return { text: out };
}

// Text outside every pair of parentheses.
function topLevel(text) {
  let depth = 0;
  let out = '';
  for (const c of text) {
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (!depth) out += c;
  }
  return out;
}

// -> { ok: true, sql } with a row limit, or { ok: false, reason }.
export function checkSelect(sql) {
  const raw = String(sql ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty statement' };
  const stripped = strip(raw);
  if (stripped.problem) return { ok: false, reason: stripped.problem };
  const text = stripped.text.trim().replace(/;\s*$/, '');
  if (text.includes(';')) return { ok: false, reason: 'more than one statement' };
  if (!/^(select|with)\b/i.test(text)) return { ok: false, reason: 'not a SELECT' };
  const write = text.match(WRITES);
  if (write) return { ok: false, reason: `"${write[1].toLowerCase()}" is not allowed in a read` };
  if (LOCKING.test(text)) return { ok: false, reason: 'row locking (FOR UPDATE / FOR SHARE) is not allowed' };
  const fn = text.match(FUNCTIONS);
  if (fn) return { ok: false, reason: `function ${fn[1].toLowerCase()} is not allowed` };
  const body = raw.replace(/;\s*$/, '');
  const limited = /\b(limit|fetch\s+first|fetch\s+next)\b/i.test(topLevel(text));
  return { ok: true, sql: limited ? body : `${body}\nLIMIT ${ROW_LIMIT}` };
}

// The only SQL /qa-this will run: one read. Postgres, MySQL and SQLite each
// read comments, quotes and escapes a little differently, and a filter that
// follows one of them can be fooled through another. So this does not try to
// follow any of them: whatever they could disagree about is refused outright.
//
//   - no comments of any kind, no backslash, no backtick, no dollar sign
//   - quoted identifiers hold plain names only, and their text is still scanned
//   - only single-quoted strings are blanked, and all three agree on those
//   - every name followed by "(" must be on a short list of read-only functions
//   - no line may start with "." or "\" (CLI commands of sqlite3 and psql)
//
// It refuses plenty of harmless SQL. A check is a count or a lookup; it does
// not need more. This is still a filter on text, not a sandbox: the database
// user behind the configured command should be read-only as well.

export const ROW_LIMIT = 50;

const WRITES = /\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|grant|revoke|copy|call|execute|exec|into|vacuum|analyze|reindex|refresh|lock|attach|detach|pragma|load|handler|set|do|notify|listen|prepare|deallocate|begin|commit|rollback|savepoint|explain|outfile|dumpfile)\b/i;
const LOCKING = /\bfor\s+(no\s+key\s+update|key\s+share|share|update)\b/i;

// Words that may come directly before "(": read-only functions, and the
// keywords and type names that take a parenthesis.
const ALLOWED = new Set(`
  count sum avg min max coalesce nullif ifnull isnull greatest least abs round floor ceil ceiling mod power sqrt sign trunc
  lower upper length char_length character_length octet_length trim ltrim rtrim btrim substring substr replace concat concat_ws
  left right lpad rpad position strpos instr starts_with reverse repeat initcap md5 to_hex
  cast now date time datetime timestamp date_trunc date_part extract to_char to_date to_timestamp age strftime julianday
  date_add date_sub datediff timestampdiff date_format unix_timestamp from_unixtime year month day hour minute
  json_extract json_array_length jsonb_array_length json_typeof jsonb_typeof json_type json_valid json_length json_unquote
  array_length cardinality array_agg string_agg group_concat bool_and bool_or every unnest
  row_number rank dense_rank ntile lag lead first_value last_value
  exists in any all some not and or on where when then else select from join by union except intersect as distinct having
  limit offset between like ilike is case using filter over group values lateral materialized row interval
  numeric decimal varchar char character text integer int bigint smallint boolean bool float double real
`.split(/\s+/).filter(Boolean));

// -> { text } with single-quoted strings blanked and identifier quotes removed, or { problem }.
export function strip(sql) {
  const s = String(sql ?? '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') return { problem: 'a backslash is not allowed' };
    if (c === '\0') return { problem: 'a NUL byte is not allowed' };
    if (c === '`') return { problem: 'backticks are not allowed: write the name without quotes' };
    if (c === '$') return { problem: 'a dollar sign is not allowed (no dollar quoting, no parameters)' };
    if (c === '#' || s.startsWith('--', i) || s.startsWith('/*', i)) return { problem: 'comments are not allowed' };
    if (c === "'" || c === '"') {
      // U&'…' and U&"…" take an escape character of the author's choosing.
      if (/u&\s*$/i.test(s.slice(Math.max(0, i - 8), i))) return { problem: 'unicode-escaped quotes (U&) are not allowed' };
      let j = i + 1;
      for (;;) {
        if (j >= s.length) return { problem: 'unterminated quote' };
        if (s[j] === '\\') return { problem: 'a backslash is not allowed' };
        if (s[j] === c) {
          if (s[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      const inner = s.slice(i + 1, j);
      if (c === "'") out += "''";
      else if (!/^[A-Za-z_][A-Za-z0-9_ ]*$/.test(inner)) return { problem: 'a double-quoted name may hold only letters, digits, spaces and underscores' };
      // The name stays visible to every scan below.
      else out += ` ${inner} `;
      i = j + 1;
    } else if (c === '[') {
      // SQLite and SQL Server quote names with brackets; Postgres indexes arrays with them.
      const end = s.indexOf(']', i);
      if (end === -1) return { problem: 'unterminated [' };
      if (/['"]/.test(s.slice(i, end))) return { problem: 'a quote inside [ ] is not allowed' };
      out += s.slice(i, end + 1);
      i = end + 1;
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
  if (raw.length > 4000) return { ok: false, reason: 'statement longer than 4000 characters' };
  // psql reads a line starting with "\" as a command, sqlite3 one starting with ".".
  if (raw.split(/\r\n|\r|\n/).some((line) => /^\s*[.\\]/.test(line))) return { ok: false, reason: 'a line may not start with "." or "\\"' };
  const stripped = strip(raw);
  if (stripped.problem) return { ok: false, reason: stripped.problem };
  const text = stripped.text.trim().replace(/;\s*$/, '');
  if (text.includes(';')) return { ok: false, reason: 'more than one statement' };
  if (!/^(select|with)\b/i.test(text)) return { ok: false, reason: 'not a SELECT' };
  if (text.includes(':=')) return { ok: false, reason: 'variable assignment is not allowed' };
  const write = text.match(WRITES);
  if (write) return { ok: false, reason: `"${write[1].toLowerCase()}" is not allowed in a read` };
  if (LOCKING.test(text)) return { ok: false, reason: 'row locking (FOR UPDATE / FOR SHARE) is not allowed' };
  for (const m of text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (!ALLOWED.has(m[1].toLowerCase())) return { ok: false, reason: `function ${m[1].toLowerCase()} is not on the read-only list` };
  }
  const body = raw.replace(/;\s*$/, '');
  const limited = /\b(limit|fetch\s+first|fetch\s+next)\b/i.test(topLevel(text));
  return { ok: true, sql: limited ? body : `${body}\nLIMIT ${ROW_LIMIT}` };
}

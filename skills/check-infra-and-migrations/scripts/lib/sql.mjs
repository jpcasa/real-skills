// SQL migrations, one statement at a time. splitStatements cuts a file at
// top-level semicolons and builds a skeleton of each statement: comments gone,
// every string literal and dollar-quoted body replaced by `?`. classify reads
// the skeleton only, so a DROP inside a string, a comment or a function body
// never fires a rule. A statement that matches nothing is `unparsed`, never
// assumed harmless, and so is anything the splitter cannot be sure it cut
// right: a psql `\` line, everything after a MySQL DELIMITER, and everything
// after a string with a backslash before a quote (a different string in MySQL
// than in standard SQL).

const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

// -> [{ text, skeleton, line }]   line: where the statement's first token is.
export function splitStatements(text) {
  const src = String(text ?? '');
  const out = [];
  let skel = '';
  let raw = '';
  let line = 1;
  let startLine = null;
  // Once true, statement boundaries from here on are a guess.
  let ambiguous = false;
  const push = () => {
    const skeleton = squash(skel);
    if (/^DELIMITER\b/i.test(skeleton)) ambiguous = true;
    if (skeleton) out.push({ text: raw.trim(), skeleton, line: startLine ?? line, ...(ambiguous ? { ambiguous: true } : {}) });
    skel = '';
    raw = '';
    startLine = null;
  };
  // Adds to the skeleton; the first visible character fixes the start line.
  const add = (s, at) => {
    if (startLine === null && /\S/.test(s)) startLine = at;
    skel += s;
  };
  const lines = (s) => (s.match(/\n/g) || []).length;

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    let end;
    if (two === '--') {
      end = src.indexOf('\n', i);
      end = end === -1 ? src.length : end;
      raw += src.slice(i, end);
      skel += ' ';
      i = end;
    } else if (two === '/*') {
      let depth = 1;
      end = i + 2;
      while (end < src.length && depth) {
        if (src.startsWith('/*', end)) (depth += 1), (end += 2);
        else if (src.startsWith('*/', end)) (depth -= 1), (end += 2);
        else end += 1;
      }
      const chunk = src.slice(i, end);
      raw += chunk;
      skel += ' ';
      line += lines(chunk);
      i = end;
    } else if (c === "'") {
      // E'...' takes backslash escapes; every string doubles its quote.
      const escapes = /(^|[^\w])[Ee]$/.test(skel);
      end = i + 1;
      while (end < src.length) {
        if (escapes && src[end] === '\\') end += 2;
        else if (src[end] === '\\' && src[end + 1] === "'") {
          // Standard SQL ends the string at that quote; MySQL does not.
          ambiguous = true;
          end += 1;
        } else if (src[end] === "'" && src[end + 1] === "'") end += 2;
        else if (src[end] === "'") break;
        else end += 1;
      }
      end = Math.min(end + 1, src.length);
      const chunk = src.slice(i, end);
      raw += chunk;
      skel = skel.replace(/(^|[^\w])[EeNnBbXx]$/, '$1');
      add('?', line);
      line += lines(chunk);
      i = end;
    } else if (c === '"' || c === '`') {
      end = i + 1;
      while (end < src.length && !(src[end] === c && src[end + 1] !== c)) end += src[end] === c ? 2 : 1;
      end = Math.min(end + 1, src.length);
      const chunk = src.slice(i, end);
      raw += chunk;
      add(chunk, line);
      line += lines(chunk);
      i = end;
    } else if (c === '$' && !/\w/.test(src[i - 1] || '') && /^\$([A-Za-z_]\w*)?\$/.test(src.slice(i, i + 80))) {
      const tag = src.slice(i).match(/^\$([A-Za-z_]\w*)?\$/)[0];
      end = src.indexOf(tag, i + tag.length);
      end = end === -1 ? src.length : end + tag.length;
      const chunk = src.slice(i, end);
      raw += chunk;
      add('?', line);
      line += lines(chunk);
      i = end;
    } else if (c === ';') {
      raw += c;
      push();
      i += 1;
    } else if (c === '\\' && !skel.trim()) {
      // A psql meta-command ends at the line, not at a semicolon.
      end = src.indexOf('\n', i);
      end = end === -1 ? src.length : end;
      raw += src.slice(i, end);
      add(src.slice(i, end), line);
      push();
      i = end;
    } else {
      raw += c;
      add(c, line);
      if (c === '\n') line += 1;
      i += 1;
    }
  }
  push();
  return out;
}

// One line a person or Jev can read: keywords and identifiers, no literal.
export const normalize = (skeleton, max = 160) => {
  const s = squash(skeleton).replace(/\b\d+(\.\d+)?\b/g, '?');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const ID = String.raw`(?:"[^"]+"|\`[^\`]+\`|[\w$]+)(?:\.(?:"[^"]+"|\`[^\`]+\`|[\w$]+))*`;
const re = (src) => new RegExp(src.replace(/ID/g, ID), 'i');
// schema.table -> table, quotes off.
export const bare = (id) => String(id ?? '').split('.').pop().replace(/["`]/g, '');
// What two statements must share to mean the same table: unquoted parts fold
// to lower case, quoted ones are exact, and no schema means `public`.
export function tableKey(id) {
  const parts = (String(id ?? '').match(/"[^"]+"|`[^`]+`|[\w$]+/g) || []).map((p) => (/^["`]/.test(p) ? p.slice(1, -1) : p.toLowerCase()));
  const name = parts.pop() ?? '';
  const schema = parts.pop();
  return `${!schema || schema === 'public' ? '' : schema}.${name}`;
}
const T = (id) => ({ table: bare(id), tkey: tableKey(id) });

// Statements that change nothing. Transaction words must be the whole
// statement: "BEGIN" with a DROP after it and no semicolon is not a BEGIN.
const NOOP = /^((BEGIN|COMMIT|END|ROLLBACK|START TRANSACTION)( (TRANSACTION|WORK|READ ONLY|READ WRITE|DEFERRABLE|ISOLATION LEVEL (SERIALIZABLE|REPEATABLE READ|READ COMMITTED|READ UNCOMMITTED)))*$|(SAVEPOINT|RELEASE( SAVEPOINT)?|ROLLBACK TO( SAVEPOINT)?) [\w$"]+$|(SET|RESET|SHOW|COMMENT ON|ANALYZE|VACUUM|NOTIFY|LISTEN|PRAGMA|USE) )/i;
// Functions a migration calls with SELECT that touch no table data.
const SAFE_CALLS = new Set(['set_config', 'current_setting', 'setval', 'nextval', 'currval', 'pg_get_serial_sequence', 'pg_notify', 'pg_advisory_lock', 'pg_advisory_xact_lock', 'now', 'coalesce', 'max', 'min', 'count', 'format', 'concat', 'lower', 'upper', 'to_regclass', 'timezone', 'cron.schedule', 'cron.unschedule', 'over', 'in', 'any', 'all', 'exists', 'values', 'as', 'and', 'or', 'not', 'from', 'where', 'on', 'select', 'by', 'then', 'when', 'else']);
const onlySafeCalls = (s) => [...s.matchAll(/((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))*)\s*\(/g)].every((m) => SAFE_CALLS.has(m[1].replace(/"/g, '').toLowerCase().replace(/^pg_catalog\./, '')));
const OBJECT = 'FUNCTION|PROCEDURE|VIEW|MATERIALIZED VIEW|TRIGGER|TYPE|SEQUENCE|DOMAIN|AGGREGATE|EXTENSION|ROLE|USER|PUBLICATION|SCHEMA|RULE|CAST|OPERATOR|SERVER|FOREIGN TABLE';
const R = {
  dropTable: re('^DROP TABLE (?:IF EXISTS )?(.+?)(?: CASCADE| RESTRICT)?$'),
  dropSchema: /^DROP (SCHEMA|DATABASE)\b/i,
  truncate: /^TRUNCATE (?:TABLE )?(.+?)(?: (?:RESTART|CONTINUE) IDENTITY)?(?: CASCADE| RESTRICT)?$/i,
  del: re('^DELETE FROM (?:ONLY )?(ID)'),
  update: re('^UPDATE (?:ONLY )?(ID)(?: (?:AS )?(?!SET\\b)[\\w"]+)? SET\\b'),
  alterTable: re('^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(ID) (.+)$'),
  renameTable: re('^RENAME TABLE (ID) TO (ID)'),
  createIndex: re('^CREATE (?:UNIQUE )?INDEX (CONCURRENTLY )?(?:IF NOT EXISTS )?(?:ID )?ON (?:ONLY )?(ID)'),
  dropIndex: /^DROP INDEX\b/i,
  createTable: re('^CREATE (?:(?:GLOBAL |LOCAL )?TEMP(?:ORARY)? |UNLOGGED )?TABLE (?:IF NOT EXISTS )?(ID)'),
  dropPolicy: re('^DROP POLICY (?:IF EXISTS )?(ID) ON (ID)'),
  createPolicy: re('^CREATE POLICY (ID) ON (ID)'),
  dropObject: re(`^DROP (${OBJECT})\\b (?:IF EXISTS )?(ID)?`),
  cascade: /\bCASCADE$/i,
  merge: /^MERGE\b/i,
  createObject: re(`^CREATE (OR REPLACE )?(?:TEMP(?:ORARY)? |RECURSIVE |CONSTRAINT |UNIQUE )?(${OBJECT})\\b (?:IF NOT EXISTS )?(ID)?`),
  enumAdd: re('^ALTER TYPE (ID) ADD VALUE'),
  alterType: re('^ALTER TYPE (ID)'),
  grantPublic: /^(GRANT|ALTER DEFAULT PRIVILEGES)\b.*\bTO\b.*\b(PUBLIC|anon)\b/i,
  grant: /^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)\b/i,
  alterObject: /^ALTER (POLICY|FUNCTION|PROCEDURE|VIEW|MATERIALIZED VIEW|SEQUENCE|INDEX|ROLE|USER|PUBLICATION|EXTENSION|SCHEMA|DATABASE|DOMAIN|TRIGGER|SYSTEM|SERVER|FOREIGN TABLE)\b/i,
  data: /^(INSERT INTO|COPY|REFRESH MATERIALIZED VIEW)\b/i,
  call: /^(SELECT|CALL|PERFORM)\b/i,
  cte: /^WITH\b/i,
};

// The statement with everything inside parentheses removed: a WHERE in a
// subquery does not limit the statement it sits in.
function topLevel(s) {
  let depth = 0;
  let out = '';
  for (const c of s) {
    if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out;
}
// Whether a DELETE or UPDATE is limited to some rows: a WHERE at the top level
// of the statement that names at least one column. `WHERE true`, `WHERE 1=1`
// and a bare USING limit nothing. Quoted names are skipped, so a table called
// "where" is not a WHERE.
const WORDS = new Set(['TRUE', 'FALSE', 'NULL', 'AND', 'OR', 'NOT', 'IS', 'RETURNING', 'EXISTS', 'SELECT']);
function limited(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === '`') i = s.indexOf(c, i + 1) === -1 ? s.length : s.indexOf(c, i + 1);
    else if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /^WHERE\b/i.test(s.slice(i, i + 6)) && !/[\w$]/.test(s[i - 1] || '')) {
      const clause = s.slice(i + 5).replace(/\bRETURNING\b.*$/i, '');
      return (clause.match(/"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*/g) || []).some((w) => !WORDS.has(w.toUpperCase()));
    }
  }
  return false;
}

// The statement a WITH ends in: the first write or SELECT outside every parenthesis.
function mainOf(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === '`') i = s.indexOf(c, i + 1) === -1 ? s.length : s.indexOf(c, i + 1);
    else if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && i > 0 && !/[\w$]/.test(s[i - 1]) && /^(DELETE FROM|UPDATE|INSERT INTO|MERGE|SELECT)\b/i.test(s.slice(i, i + 12))) return s.slice(i);
  }
  return '';
}

// The actions of one ALTER TABLE, cut at commas outside parentheses.
function actions(rest) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '"' || c === '`') {
      // A quoted name may hold a parenthesis or a comma.
      const end = rest.indexOf(c, i + 1) === -1 ? rest.length - 1 : rest.indexOf(c, i + 1);
      cur += rest.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const A = {
  dropConstraint: /^DROP CONSTRAINT\b/i,
  dropColumn: re('^DROP (?:COLUMN )?(?:IF EXISTS )?(ID)'),
  renameConstraint: /^RENAME CONSTRAINT\b/i,
  renameTo: re('^RENAME TO (ID)'),
  renameColumn: re('^RENAME (?:COLUMN )?(ID) TO (ID)'),
  setSchema: /^SET SCHEMA\b/i,
  type: re('^ALTER (?:COLUMN )?(ID) (?:SET DATA )?TYPE\\b'),
  mysqlChange: re('^(?:MODIFY|CHANGE) (?:COLUMN )?(ID)'),
  notNull: re('^ALTER (?:COLUMN )?(ID) SET NOT NULL'),
  alterColumn: re('^ALTER (?:COLUMN )?(ID) '),
  fk: /^ADD (?:CONSTRAINT (?:"[^"]+"|`[^`]+`|\S+) )?FOREIGN KEY\b/i,
  constraint: /^ADD (?:CONSTRAINT (?:"[^"]+"|`[^`]+`|\S+) )?(CHECK|UNIQUE|PRIMARY KEY|EXCLUDE)\b/i,
  addColumn: re('^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(ID) (.*)$'),
  rlsOn: /^(ENABLE|FORCE) ROW LEVEL SECURITY/i,
  rlsOff: /^(DISABLE|NO FORCE) ROW LEVEL SECURITY/i,
  harmless: /^(OWNER TO|VALIDATE CONSTRAINT|ENABLE |DISABLE |REPLICA IDENTITY|SET \(|RESET \(|CLUSTER ON|SET WITHOUT|SET (LOGGED|UNLOGGED)|SET TABLESPACE|ATTACH PARTITION|INHERIT|NO INHERIT)/i,
};

function alterAction(id, a) {
  const hit = (rule, extra = {}) => ({ rule, ...T(id), ...extra, normalized: normalize(`ALTER TABLE ${bare(id)} ${a}`) });
  let m;
  if (A.dropConstraint.test(a)) return hit('drop_constraint');
  if (A.rlsOn.test(a)) return hit('rls_enabled');
  if (A.rlsOff.test(a)) return hit('rls_disabled');
  if ((m = a.match(A.dropColumn))) return hit('drop_column', { column: bare(m[1]) });
  if (A.renameConstraint.test(a)) return hit('alter_other');
  if ((m = a.match(A.renameTo))) return hit('rename_table', { to: bare(m[1]) });
  if ((m = a.match(A.renameColumn))) return hit('rename_column', { column: bare(m[1]), to: bare(m[2]) });
  if (A.setSchema.test(a)) return hit('rename_table');
  if ((m = a.match(A.type))) return hit('alter_column_type', { column: bare(m[1]) });
  if ((m = a.match(A.notNull))) return hit('set_not_null', { column: bare(m[1]) });
  if ((m = a.match(A.alterColumn))) return hit('alter_other', { column: bare(m[1]) });
  if ((m = a.match(A.mysqlChange))) return hit('alter_column_type', { column: bare(m[1]) });
  if (A.fk.test(a)) return hit(/\bNOT VALID\b/i.test(a) ? 'alter_other' : 'fk_without_not_valid');
  if (A.constraint.test(a)) return hit(/\bNOT VALID\b|\bUSING INDEX\b/i.test(a) ? 'alter_other' : 'add_constraint_scans_table');
  if ((m = a.match(A.addColumn))) {
    const needsValue = /\bNOT NULL\b/i.test(m[2]) && !/\b(DEFAULT|GENERATED|IDENTITY|\w*SERIAL)\b/i.test(m[2]);
    return hit(needsValue ? 'add_not_null_without_default' : 'add_column', { column: bare(m[1]) });
  }
  if (A.harmless.test(a)) return hit('alter_other');
  return hit('unparsed');
}

// stmt: { skeleton } -> [{ rule, normalized, table?, column?, to?, kind?, object? }]
// An empty list means the statement changes nothing (BEGIN, SET, COMMENT ON).
export function classify(stmt) {
  const s = stmt.skeleton;
  const hit = (rule, extra = {}) => [{ rule, normalized: normalize(s), ...extra }];
  let m;
  // The splitter could not be sure where this statement starts or ends.
  if (stmt.ambiguous) return hit('unparsed');
  if (s.startsWith('\\')) return [{ rule: 'unparsed', normalized: 'psql meta-command' }];
  if (NOOP.test(s)) return [];
  const names = (list) => list.split(',').map((t) => t.trim().replace(/^ONLY /i, '').replace(/\s*\*$/, '')).filter(Boolean);
  if ((m = s.match(R.dropTable))) return names(m[1]).map((t) => ({ rule: 'drop_table', ...T(t), normalized: normalize(`DROP TABLE ${t}`) }));
  if (R.dropSchema.test(s)) return hit('drop_schema');
  if ((m = s.match(R.truncate))) return names(m[1]).map((t) => ({ rule: 'truncate', ...T(t), normalized: normalize(`TRUNCATE ${t}`) }));
  if ((m = s.match(R.del))) return hit(limited(s) ? 'data_change' : 'delete_without_where', T(m[1]));
  if ((m = s.match(R.update))) return hit(limited(s) ? 'data_change' : 'update_without_where', T(m[1]));
  if ((m = s.match(R.alterTable))) return actions(m[2]).map((a) => alterAction(m[1], a));
  if ((m = s.match(R.renameTable))) return hit('rename_table', { ...T(m[1]), to: bare(m[2]) });
  if ((m = s.match(R.createIndex))) return hit(m[1] ? 'index_concurrent' : 'index_not_concurrent', T(m[2]));
  if (R.dropIndex.test(s)) return hit('drop_index');
  // IF NOT EXISTS may create nothing: the table can already be there, with rows.
  if ((m = s.match(R.createTable))) return hit('create_table', { ...T(m[1]), if_not_exists: /^CREATE [A-Z ]*TABLE IF NOT EXISTS\b/i.test(s), normalized: normalize(s.replace(/\s*\(.*$/, ' (…)')) });
  if ((m = s.match(R.dropPolicy))) return hit('policy_dropped', { kind: 'policy', object: bare(m[1]), ...T(m[2]) });
  if ((m = s.match(R.createPolicy))) return hit('create_policy', { kind: 'policy', object: bare(m[1]), ...T(m[2]) });
  if ((m = s.match(R.dropObject))) {
    const kind = m[1].toLowerCase();
    // CASCADE on a type, domain or extension drops every column that uses it.
    const rule = kind === 'schema' ? 'drop_schema' : R.cascade.test(s) && ['type', 'domain', 'extension'].includes(kind) ? 'drop_cascade' : 'drop_object';
    return hit(rule, { kind, object: bare(m[2]), cascade: R.cascade.test(s) });
  }
  if ((m = s.match(R.createObject))) return hit(m[1] ? 'replace_object' : 'create_object', { kind: m[2].toLowerCase(), object: bare(m[3]) });
  if (R.enumAdd.test(s)) return hit('enum_value_added');
  if (R.alterType.test(s)) return hit('alter_type');
  if (R.grantPublic.test(s)) return hit('grant_to_public');
  if (R.grant.test(s)) return hit('grant_changed');
  if (R.alterObject.test(s)) return hit('alter_other');
  if (R.data.test(s)) return hit('data_change');
  // MERGE can delete on a match or on a miss, limited only by its ON: read by a person.
  if (R.merge.test(s)) return hit(/\bTHEN DELETE\b/i.test(s) ? 'unparsed' : 'data_change');
  // A function can do anything. Only the well-known harmless ones are a note.
  if (R.call.test(s)) return hit(/^SELECT\b/i.test(s) && onlySafeCalls(s) ? 'function_call' : 'unparsed');
  if (R.cte.test(s)) {
    // WITH … followed by a write. The CTEs are in parentheses; what is left is the statement itself.
    const top = topLevel(s);
    // A CTE that itself deletes or updates: its own WHERE is out of reach here.
    if (/\(\s*(DELETE FROM|UPDATE|TRUNCATE)\b/i.test(s)) return hit('unparsed');
    const main = mainOf(s);
    if ((m = top.match(re('\\bDELETE FROM (?:ONLY )?(ID)')))) return hit(limited(main) ? 'data_change' : 'delete_without_where', T(m[1]));
    if ((m = top.match(re('\\bUPDATE (?:ONLY )?(ID)')))) return hit(limited(main) ? 'data_change' : 'update_without_where', T(m[1]));
    if (/\bMERGE\b/i.test(top)) return hit('unparsed');
    if (/\bINSERT INTO\b/i.test(top)) return hit('data_change');
    if (/\bSELECT\b/i.test(top) && onlySafeCalls(main)) return hit('function_call');
  }
  return hit('unparsed');
}

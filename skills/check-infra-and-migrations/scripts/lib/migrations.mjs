// Findings for migration files: what each statement does (sql.mjs for SQL, a
// small pattern table for Rails, Alembic, Knex and Django), and whether the
// migration history itself still applies cleanly.

import { splitStatements, classify } from './sql.mjs';
import { RULES } from './rules.mjs';

// Files in a migrations folder that are not migrations: journals, snapshots, locks.
export const isMeta = (file) =>
  /(^|\/)meta\//.test(file) || /\.(json|toml|lock|md|ya?ml|txt|mako)$/i.test(file) || /(^|\/)(__init__\.py|env\.py|schema\.prisma|README[^/]*|\.gitkeep)$/.test(file);
export const isSql = (file) => /\.sql$/i.test(file);

// Calls that destroy or rename, in the migration DSLs that are not SQL.
const DSL = [
  [/\b(drop_table|dropTable|dropTableIfExists|DeleteModel)\b/, 'drop_table'],
  [/\b(remove_columns?|dropColumns?|drop_column|RemoveField)\b/, 'drop_column'],
  [/\b(rename_column|renameColumn|RenameField)\b|\bnew_column_name\s*=/, 'rename_column'],
  [/\b(rename_table|renameTable|RenameModel)\b/, 'rename_table'],
  [/\b(change_column|AlterField)\b|\balter_column\([^)]*\btype_\s*=/, 'alter_column_type'],
];
// Raw SQL or arbitrary code inside a DSL migration: not readable here.
const DSL_RAW = /\b(execute|RunSQL|RunPython)\b|\.raw\(/;
const DOWN = /^\s*(def (down|downgrade)\b|exports\.down\b|export (async )?function down\b|(async )?down\s*[(:=])/m;
const UP = /^\s*(def (up|upgrade|change)\b|exports\.up\b|export (async )?function up\b|(async )?up\s*[(:=])/m;

// The part of a DSL migration that runs forwards.
function forwardPart(text) {
  const down = text.search(DOWN);
  if (down === -1) return { text, offset: 0 };
  const up = text.search(UP);
  if (up > down) return { text: text.slice(up), offset: text.slice(0, up).split('\n').length - 1 };
  return { text: text.slice(0, down), offset: 0 };
}

// ctx.created: keys of tables created earlier in this change. ctx.maybe: tables
// "created" with IF NOT EXISTS, which may have been there all along. Mutated.
// -> { findings, statements, unparsed }
export function fileFindings(file, text, ctx = { created: new Set() }) {
  ctx.maybe ??= new Set();
  const findings = [];
  const statements = [];
  const unparsed = [];
  const add = (hit, line) => {
    statements.push({ file, line, normalized: hit.normalized, rule: hit.rule });
    if (hit.rule === 'unparsed') {
      unparsed.push({ file, line, normalized: hit.normalized });
      return;
    }
    const key = hit.tkey ?? null;
    const f = { source: 'rule', bucket: 'migration', file, line, ...hit };
    const r = RULES[hit.rule];
    if (hit.rule === 'create_table') (hit.if_not_exists ? ctx.maybe : ctx.created).add(key);
    else if (key && r.severity !== 'note') {
      // A table that may already exist can still lose data or break code: only
      // its locks and scans are let off, never a drop, a rename or a rewrite.
      const harmless = ctx.created.has(key) || (ctx.maybe.has(key) && (r.lock || r.soft) && r.reversible !== false && !r.breaks);
      if (harmless) Object.assign(f, { rule: 'on_new_table', was: hit.rule });
    }
    findings.push(f);
  };

  if (isSql(file)) {
    for (const stmt of splitStatements(text)) for (const hit of classify(stmt)) add(hit, stmt.line);
    // DROP then CREATE of the same object in one file is a replacement.
    findings.forEach((f, i) => {
      // With CASCADE the drop takes its dependents along: the create does not bring them back.
      if ((f.rule !== 'policy_dropped' && f.rule !== 'drop_object') || f.cascade) return;
      const again = findings.slice(i + 1).some((g) => ['create_policy', 'create_object', 'replace_object'].includes(g.rule) && g.kind === f.kind && g.object === f.object && (f.kind !== 'policy' || g.table === f.table));
      if (again) Object.assign(f, { rule: 'replace_object', was: f.rule });
    });
    return { findings, statements, unparsed };
  }

  const fwd = forwardPart(String(text ?? ''));
  fwd.text.split('\n').forEach((l, i) => {
    const line = i + 1 + fwd.offset;
    if (/^\s*(#|\/\/|\*)/.test(l)) return;
    const m = DSL.map(([re, rule]) => ({ rule, call: l.match(re)?.[0] })).find((x) => x.call);
    if (m) add({ rule: m.rule, normalized: `${m.rule} (${m.call.replace(/\W+$/, '')} call)` }, line);
    else if (DSL_RAW.test(l)) add({ rule: 'unparsed', normalized: 'raw SQL or code inside a migration' }, line);
  });
  // Only the destructive calls are recognised: the rest of the file was not read.
  unparsed.push({ file, line: 1, normalized: 'not SQL: only destructive calls are recognised' });
  return { findings, statements, unparsed };
}

const numKey = (name) => {
  const m = String(name).match(/^(\d+)/);
  return m ? BigInt(m[1]) : null;
};
// Which folder a migration is ordered within, and its name there.
const place = (file, entry) => {
  if (entry?.dir && file.startsWith(`${entry.dir}/`)) return { group: entry.dir, name: file.slice(entry.dir.length + 1).split('/')[0] };
  const at = file.lastIndexOf('/');
  return { group: file.slice(0, Math.max(at, 0)), name: file.slice(at + 1) };
};

// changed: [{ file, status, old_file?, entry }]   baseFiles: migration paths at the base tip.
export function historyFindings(changed, baseFiles, entryOf) {
  const findings = [];
  const newest = new Map();
  for (const b of baseFiles.filter((f) => !isMeta(f))) {
    const { group, name } = place(b, entryOf(b));
    const k = numKey(name);
    if (k !== null && (!newest.has(group) || k > newest.get(group).k)) newest.set(group, { k, name });
  }
  for (const c of changed.filter((x) => !isMeta(x.file))) {
    const base = { source: 'rule', bucket: 'migration', file: c.file, line: c.status === 'deleted' ? null : 1 };
    if (c.status !== 'added') {
      const what = c.status === 'deleted' ? 'delete' : c.status === 'renamed' ? `rename from ${c.old_file}` : 'edit';
      findings.push({ ...base, rule: 'edited_existing_migration', normalized: `${what} existing migration ${c.file}` });
      continue;
    }
    const { group, name } = place(c.file, c.entry);
    const k = numKey(name);
    const top = newest.get(group);
    if (k !== null && top && k <= top.k) findings.push({ ...base, rule: 'out_of_order', normalized: `add migration ${name} at or before ${top.name}`, newest: top.name });
  }
  return findings;
}

// Drizzle: every .sql file has a journal entry and every entry has its file.
export function journalFindings(dir, journalText, headFiles) {
  if (!journalText) return [];
  let tags;
  try {
    tags = (JSON.parse(journalText).entries || []).map((e) => String(e.tag));
  } catch {
    return [{ source: 'rule', bucket: 'migration', rule: 'journal_mismatch', file: `${dir}/meta/_journal.json`, line: 1, normalized: 'journal is not valid JSON', detail: 'It is not valid JSON.' }];
  }
  const files = headFiles.filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/') && isSql(f)).map((f) => f.slice(dir.length + 1).replace(/\.sql$/i, ''));
  const out = [];
  // Names come from the change itself and end up in a PR comment: only plain ones are shown.
  const show = (n) => (/^[\w.-]{1,120}$/.test(n) ? n : 'a name with unusual characters');
  for (const f of files.filter((x) => !tags.includes(x))) out.push({ detail: `\`${show(f)}.sql\` has no journal entry.`, normalized: `migration ${show(f)} missing from journal` });
  for (const t of tags.filter((x) => !files.includes(x))) out.push({ detail: `Journal entry \`${show(t)}\` has no file.`, normalized: `journal entry ${show(t)} has no file` });
  return out.slice(0, 5).map((o) => ({ source: 'rule', bucket: 'migration', rule: 'journal_mismatch', file: `${dir}/meta/_journal.json`, line: 1, ...o }));
}

// Which side of the deploy a change can break. applied: before_deploy | after_deploy | manual.
export function windowFindings(findings, applied) {
  const out = [];
  if (applied === 'before_deploy' || applied === 'manual') for (const f of findings) if (RULES[f.rule]?.breaks) f.window = 'old_code';
  if (applied === 'after_deploy' || applied === 'manual') {
    const additive = findings.filter((f) => RULES[f.rule]?.additive);
    if (additive.length) out.push({ source: 'rule', bucket: 'migration', rule: 'new_code_needs_schema', file: additive[0].file, line: additive[0].line, count: additive.length, normalized: `${additive.length} additive change${additive.length === 1 ? '' : 's'} applied after the code deploys` });
  }
  return out;
}

// Names worth searching the code for after a drop or a rename: the name as
// written and its camelCase form, four characters or more.
export function referencedNames(f) {
  if (!['drop_table', 'drop_column', 'rename_table', 'rename_column'].includes(f.rule)) return [];
  const name = f.column || f.table;
  if (!name || name.length < 4 || !/^[A-Za-z_][\w$]*$/.test(name)) return [];
  const camel = name.replace(/_+([a-z0-9])/g, (_, c) => c.toUpperCase());
  return [...new Set([name, camel])];
}

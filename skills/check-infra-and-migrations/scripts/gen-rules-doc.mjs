#!/usr/bin/env node
// Writes references/rules.md from lib/rules.mjs, so the rule table people read
// is the one the harness uses. Run after changing a rule:
//   node skills/check-infra-and-migrations/scripts/gen-rules-doc.mjs
// scripts/test/skill.test.mjs fails when the file is stale.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES } from './lib/rules.mjs';

const GROUPS = [
  ['Migration history and deploy window', /^(edited_|journal_|out_of_|still_|new_code)/],
  ['Live reads', /^(target_|pending_|plan_)/],
  ['Infrastructure, pipeline and env files (from the diff text)', /^(stateful_|deletion_|open_|iam_|service_|env_|pipeline_)/],
  ['Jev (only once /calibrate switched the question on)', /^jev_/],
];
const groupOf = (name) => GROUPS.find(([, re]) => re.test(name))?.[0] || 'SQL statements';
const cap = (s) => s[0].toUpperCase() + s.slice(1);

export function render() {
  let out = '# Rules\n\nEvery rule the harness can fire. `blocker`: data loss, or a migration history that cannot apply cleanly. `risk`: can break running code, lock a table or take something down. `note`: belongs in the runbook and never moves the verdict.\n\nGenerated from `scripts/lib/rules.mjs` by `scripts/gen-rules-doc.mjs`. Do not edit by hand.\n';
  for (const title of ['SQL statements', ...GROUPS.map(([t]) => t)]) {
    out += `\n## ${title}\n\n| Rule | Severity | Fires when the change |\n|---|---|---|\n`;
    for (const [name, r] of Object.entries(RULES)) if (groupOf(name) === title) out += `| \`${name}\` | ${r.severity} | ${cap(r.says)} |\n`;
  }
  out += [
    '\n## How a rule is softened or raised, in code\n',
    '- **A table this change creates.** A lock, scan, drop or rename on a table created earlier in the same change is `on_new_table`: there are no rows yet. A drop that comes before the create is about the old table and stays what it is. The table must be the same one: same schema (none means `public`), and a quoted name matches exactly.',
    '- **`CREATE TABLE IF NOT EXISTS`** may create nothing, because the table can already be there with rows. Only locks, scans and turning row-level security on are let off for such a table. A drop, a rename, a type change or a delete on it stays what it is.',
    '- **Drop, then create.** `DROP POLICY` or `DROP FUNCTION` followed in the same file by a create of the same object is `replace_object`. Not with `CASCADE`: that drop takes its dependents along, and the create does not bring them back.',
    '- **A limit that limits nothing.** A `DELETE` or `UPDATE` counts as limited only by a `WHERE` at its own top level that names a column. `WHERE true`, `WHERE 1=1`, a `WHERE` inside a subquery and a bare `USING` limit nothing.',
    '- **Functions.** `SELECT` of a short list of built-ins (`setval`, `set_config`, `cron.schedule`, …) is `function_call`. Any other `SELECT fn()` or `CALL` is unparsed: a function can do anything.',
    '- **Deploy window.** With migrations applied `before_deploy` or by hand, every rule that breaks existing code is marked: old code runs against it until the deploy finishes. With `after_deploy`, additive changes produce one `new_code_needs_schema` note.',
    '- **A big table.** With a `sizes` read, a rule that locks or scans a table over `big_table_rows` becomes a blocker, and says the row count.',
    '- **Unparsed.** A statement that matches no rule is not a finding. It is listed as not checked, and the verdict cannot be `safe`. The same goes for anything the splitter cannot be sure it cut right: a psql `\\` line, everything after a MySQL `DELIMITER`, and everything after a string with a backslash before a quote.',
    '- **Not SQL.** In a Rails, Alembic, Knex or Django migration only the destructive calls are recognised; the file as a whole is listed as not checked.',
    '- **Infrastructure.** These rules read added and removed lines. A declaration that moved to another line or file is not a removal; a setting on a new resource is not a change; `0.0.0.0/0` in an egress rule is not ingress, and a comment does not decide which it is.',
    '\nNothing else changes a rule hit: not the agent, and not Jev.\n',
  ].join('\n');
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = join(dirname(fileURLToPath(import.meta.url)), '../references/rules.md');
  writeFileSync(file, render());
  process.stdout.write(`${file}\n`);
}

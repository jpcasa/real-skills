// Every rule this skill can fire, and the verdict they add up to. A rule is a
// name, a severity and one sentence a teammate can read. Nothing here reads a
// file: sql.mjs, migrations.mjs, infra.mjs and live.mjs decide when a rule fires.
//
//   blocker  data loss, or a migration history that cannot apply cleanly
//   risk     can break running code, lock a table or take something down
//   note     belongs in the runbook; never moves the verdict

export const SEVERITIES = ['blocker', 'risk', 'note'];
export const VERDICTS = ['blocked', 'caution', 'unverified', 'safe', 'nothing_to_check'];
export const BUCKETS = ['migration', 'infra', 'pipeline', 'env'];

const B = 'blocker';
const R = 'risk';
const N = 'note';
// reversible: false = running it loses something a down-migration cannot bring back.
// lock: the statement scans, rewrites or locks the table, so its size matters.
// breaks: old code that still uses the object fails once this has run.
// soft: like a lock, let off on a table that this change created with IF NOT EXISTS.
export const RULES = {
  // --- SQL statements
  drop_table: { severity: B, says: 'drops a table: its rows are gone once this runs', reversible: false, breaks: true },
  drop_column: { severity: B, says: 'drops a column: its data is gone once this runs', reversible: false, breaks: true },
  truncate: { severity: B, says: 'empties a table', reversible: false },
  drop_schema: { severity: B, says: 'drops a schema or database and everything in it', reversible: false, breaks: true },
  delete_without_where: { severity: B, says: 'deletes every row of a table', reversible: false },
  alter_column_type: { severity: R, says: 'changes a column type: the table can be rewritten under a lock, and values that do not convert fail or are cut', reversible: false, lock: true, breaks: true },
  set_not_null: { severity: R, says: 'adds NOT NULL: the table is scanned under a lock, and it fails if a NULL exists', lock: true },
  add_not_null_without_default: { severity: R, says: 'adds a NOT NULL column with no default: it fails on a table that has rows', lock: true },
  rename_table: { severity: R, says: 'renames a table: code that uses the old name fails', breaks: true },
  rename_column: { severity: R, says: 'renames a column: code that uses the old name fails', breaks: true },
  index_not_concurrent: { severity: R, says: 'builds an index without CONCURRENTLY: writes to the table wait until it finishes', lock: true },
  fk_without_not_valid: { severity: R, says: 'adds a foreign key without NOT VALID: both tables are locked while every row is checked', lock: true },
  add_constraint_scans_table: { severity: R, says: 'adds a constraint that scans the whole table under a lock', lock: true },
  update_without_where: { severity: R, says: 'updates every row of a table in one statement', reversible: false, lock: true },
  rls_enabled: { severity: R, says: 'turns row-level security on for an existing table: without a matching policy every query returns no rows', soft: true },
  rls_disabled: { severity: R, says: 'turns row-level security off for a table' },
  policy_dropped: { severity: R, says: 'drops a row-level security policy and does not recreate it' },
  grant_to_public: { severity: R, says: 'grants access to PUBLIC or to the anonymous role' },
  drop_object: { severity: R, says: 'drops a function, view, trigger, type or sequence: code that uses it fails', breaks: true },
  drop_cascade: { severity: B, says: 'drops a type, domain or extension with CASCADE: every column that uses it is dropped with its data', reversible: false, breaks: true },
  alter_type: { severity: R, says: 'changes a type that running code may depend on', breaks: true },
  create_table: { severity: N, says: 'creates a table', additive: true },
  add_column: { severity: N, says: 'adds a column', additive: true },
  index_concurrent: { severity: N, says: 'builds an index concurrently: it cannot run inside a transaction' },
  create_policy: { severity: N, says: 'creates a row-level security policy' },
  create_object: { severity: N, says: 'creates a function, view, trigger, type or other object', additive: true },
  replace_object: { severity: N, says: 'replaces an object in place' },
  data_change: { severity: N, says: 'changes rows, not structure' },
  drop_index: { severity: N, says: 'drops an index: queries that used it get slower' },
  drop_constraint: { severity: N, says: 'drops a constraint' },
  alter_other: { severity: N, says: 'changes a setting that does not rewrite or lock data' },
  enum_value_added: { severity: N, says: 'adds an enum value: on older Postgres it cannot run inside a transaction' },
  grant_changed: { severity: N, says: 'changes privileges' },
  function_call: { severity: N, says: 'calls a built-in function that touches no table data' },
  on_new_table: { severity: N, says: 'acts on a table this change creates: there are no rows to lock or lose yet' },
  // --- migration history
  edited_existing_migration: { severity: B, says: 'changes or removes a migration that already exists on the base branch: an environment that ran the old one will never run this' },
  journal_mismatch: { severity: B, says: 'does not match the migration files: the tool will skip or refuse a migration' },
  out_of_order: { severity: R, says: 'sorts before a migration that is already on the base branch: an environment that is past it may skip this one' },
  still_referenced: { severity: R, says: 'is still named in code at the head of this change' },
  new_code_needs_schema: { severity: N, says: 'the new code goes live before these migrations run, so it must work without them for a while' },
  // --- live reads
  target_ahead: { severity: R, says: 'the target has applied a migration that this change does not contain' },
  pending_outside_range: { severity: N, says: 'has not run on the target and is not part of this change: it runs with this release' },
  plan_destroys_stateful: { severity: B, says: 'the plan destroys a resource that holds data', reversible: false },
  plan_replaces_stateful: { severity: B, says: 'the plan replaces a resource that holds data: the old one is deleted', reversible: false },
  plan_destroys_resource: { severity: R, says: 'the plan destroys a resource' },
  plan_replaces_resource: { severity: R, says: 'the plan replaces a resource: expect it to be unavailable while that happens' },
  // --- infrastructure, from the diff text
  stateful_resource_removed: { severity: B, says: 'removes the declaration of a resource that holds data', reversible: false },
  deletion_guard_weakened: { severity: R, says: 'weakens a guard against deleting a resource or its data' },
  open_ingress: { severity: R, says: 'opens network access to any address' },
  iam_wildcard: { severity: R, says: 'grants every action, or every action of a service' },
  iam_any_resource: { severity: N, says: 'allows named actions on any resource' },
  service_config_changed: { severity: R, says: 'changes how a service is sized, placed or run' },
  env_var_removed: { severity: R, says: 'removes an environment variable from a service definition' },
  pipeline_changed: { severity: N, says: 'changes the deploy pipeline itself' },
  // --- env example files
  env_var_added: { severity: N, says: 'is a new environment variable: it must exist on the target before the deploy' },
  env_example_removed: { severity: N, says: 'is no longer in the env example file' },
  // --- Jev, only once a question is switched on by /calibrate
  jev_destroys_data: { severity: B, says: 'Jev reads this as losing data that cannot be rebuilt' },
  jev_breaks_running_code: { severity: R, says: 'Jev reads this as breaking code that is running during the deploy' },
  jev_infra_disruptive: { severity: R, says: 'Jev reads this as causing downtime or a replacement' },
  jev_not_safe: { severity: R, says: 'Jev does not read this release as safe to push with the normal deploy' },
};
export const RULE_NAMES = Object.keys(RULES);
// Rules whose severity is raised to blocker on a table over `big_table_rows`.
export const LOCK_RULES = RULE_NAMES.filter((r) => RULES[r].lock);

export const severityOf = (f) => (SEVERITIES.includes(f.severity) ? f.severity : RULES[f.rule]?.severity || 'note');

// findings: what survived checking. unchecked: reasons something could not be read.
export function verdict({ findings = [], unchecked = [], bucketed = 1 }) {
  const counts = { blocker: 0, risk: 0, note: 0 };
  for (const f of findings) counts[severityOf(f)] += 1;
  if (!bucketed) return { verdict: 'nothing_to_check', counts, unchecked: [] };
  const v = counts.blocker ? 'blocked' : counts.risk ? 'caution' : unchecked.length ? 'unverified' : 'safe';
  return { verdict: v, counts, unchecked };
}

const RANK = { blocker: 0, risk: 1, note: 2 };
export const bySeverity = (a, b) => RANK[severityOf(a)] - RANK[severityOf(b)] || String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0);

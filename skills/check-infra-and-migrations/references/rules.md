# Rules

Every rule the harness can fire. `blocker`: data loss, or a migration history that cannot apply cleanly. `risk`: can break running code, lock a table or take something down. `note`: belongs in the runbook and never moves the verdict.

Generated from `scripts/lib/rules.mjs` by `scripts/gen-rules-doc.mjs`. Do not edit by hand.

## SQL statements

| Rule | Severity | Fires when the change |
|---|---|---|
| `drop_table` | blocker | Drops a table: its rows are gone once this runs |
| `drop_column` | blocker | Drops a column: its data is gone once this runs |
| `truncate` | blocker | Empties a table |
| `drop_schema` | blocker | Drops a schema or database and everything in it |
| `delete_without_where` | blocker | Deletes every row of a table |
| `alter_column_type` | risk | Changes a column type: the table can be rewritten under a lock, and values that do not convert fail or are cut |
| `set_not_null` | risk | Adds NOT NULL: the table is scanned under a lock, and it fails if a NULL exists |
| `add_not_null_without_default` | risk | Adds a NOT NULL column with no default: it fails on a table that has rows |
| `rename_table` | risk | Renames a table: code that uses the old name fails |
| `rename_column` | risk | Renames a column: code that uses the old name fails |
| `index_not_concurrent` | risk | Builds an index without CONCURRENTLY: writes to the table wait until it finishes |
| `fk_without_not_valid` | risk | Adds a foreign key without NOT VALID: both tables are locked while every row is checked |
| `add_constraint_scans_table` | risk | Adds a constraint that scans the whole table under a lock |
| `update_without_where` | risk | Updates every row of a table in one statement |
| `rls_enabled` | risk | Turns row-level security on for an existing table: without a matching policy every query returns no rows |
| `rls_disabled` | risk | Turns row-level security off for a table |
| `policy_dropped` | risk | Drops a row-level security policy and does not recreate it |
| `grant_to_public` | risk | Grants access to PUBLIC or to the anonymous role |
| `drop_object` | risk | Drops a function, view, trigger, type or sequence: code that uses it fails |
| `drop_cascade` | blocker | Drops a type, domain or extension with CASCADE: every column that uses it is dropped with its data |
| `alter_type` | risk | Changes a type that running code may depend on |
| `create_table` | note | Creates a table |
| `add_column` | note | Adds a column |
| `index_concurrent` | note | Builds an index concurrently: it cannot run inside a transaction |
| `create_policy` | note | Creates a row-level security policy |
| `create_object` | note | Creates a function, view, trigger, type or other object |
| `replace_object` | note | Replaces an object in place |
| `data_change` | note | Changes rows, not structure |
| `drop_index` | note | Drops an index: queries that used it get slower |
| `drop_constraint` | note | Drops a constraint |
| `alter_other` | note | Changes a setting that does not rewrite or lock data |
| `enum_value_added` | note | Adds an enum value: on older Postgres it cannot run inside a transaction |
| `grant_changed` | note | Changes privileges |
| `function_call` | note | Calls a built-in function that touches no table data |
| `on_new_table` | note | Acts on a table this change creates: there are no rows to lock or lose yet |

## Migration history and deploy window

| Rule | Severity | Fires when the change |
|---|---|---|
| `edited_existing_migration` | blocker | Changes or removes a migration that already exists on the base branch: an environment that ran the old one will never run this |
| `journal_mismatch` | blocker | Does not match the migration files: the tool will skip or refuse a migration |
| `out_of_order` | risk | Sorts before a migration that is already on the base branch: an environment that is past it may skip this one |
| `still_referenced` | risk | Is still named in code at the head of this change |
| `new_code_needs_schema` | note | The new code goes live before these migrations run, so it must work without them for a while |

## Live reads

| Rule | Severity | Fires when the change |
|---|---|---|
| `target_ahead` | risk | The target has applied a migration that this change does not contain |
| `pending_outside_range` | note | Has not run on the target and is not part of this change: it runs with this release |
| `plan_destroys_stateful` | blocker | The plan destroys a resource that holds data |
| `plan_replaces_stateful` | blocker | The plan replaces a resource that holds data: the old one is deleted |
| `plan_destroys_resource` | risk | The plan destroys a resource |
| `plan_replaces_resource` | risk | The plan replaces a resource: expect it to be unavailable while that happens |

## Infrastructure, pipeline and env files (from the diff text)

| Rule | Severity | Fires when the change |
|---|---|---|
| `stateful_resource_removed` | blocker | Removes the declaration of a resource that holds data |
| `deletion_guard_weakened` | risk | Weakens a guard against deleting a resource or its data |
| `open_ingress` | risk | Opens network access to any address |
| `iam_wildcard` | risk | Grants every action, or every action of a service |
| `iam_any_resource` | note | Allows named actions on any resource |
| `service_config_changed` | risk | Changes how a service is sized, placed or run |
| `env_var_removed` | risk | Removes an environment variable from a service definition |
| `pipeline_changed` | note | Changes the deploy pipeline itself |
| `env_var_added` | note | Is a new environment variable: it must exist on the target before the deploy |
| `env_example_removed` | note | Is no longer in the env example file |

## Jev (only once /calibrate switched the question on)

| Rule | Severity | Fires when the change |
|---|---|---|
| `jev_destroys_data` | blocker | Jev reads this as losing data that cannot be rebuilt |
| `jev_breaks_running_code` | risk | Jev reads this as breaking code that is running during the deploy |
| `jev_infra_disruptive` | risk | Jev reads this as causing downtime or a replacement |
| `jev_not_safe` | risk | Jev does not read this release as safe to push with the normal deploy |

## How a rule is softened or raised, in code

- **A table this change creates.** A lock, scan, drop or rename on a table created earlier in the same change is `on_new_table`: there are no rows yet. A drop that comes before the create is about the old table and stays what it is. The table must be the same one: same schema (none means `public`), and a quoted name matches exactly.
- **`CREATE TABLE IF NOT EXISTS`** may create nothing, because the table can already be there with rows. Only locks, scans and turning row-level security on are let off for such a table. A drop, a rename, a type change or a delete on it stays what it is.
- **Drop, then create.** `DROP POLICY` or `DROP FUNCTION` followed in the same file by a create of the same object is `replace_object`. Not with `CASCADE`: that drop takes its dependents along, and the create does not bring them back.
- **A limit that limits nothing.** A `DELETE` or `UPDATE` counts as limited only by a `WHERE` at its own top level that names a column. `WHERE true`, `WHERE 1=1`, a `WHERE` inside a subquery and a bare `USING` limit nothing.
- **Functions.** `SELECT` of a short list of built-ins (`setval`, `set_config`, `cron.schedule`, …) is `function_call`. Any other `SELECT fn()` or `CALL` is unparsed: a function can do anything.
- **Deploy window.** With migrations applied `before_deploy` or by hand, every rule that breaks existing code is marked: old code runs against it until the deploy finishes. With `after_deploy`, additive changes produce one `new_code_needs_schema` note.
- **A big table.** With a `sizes` read, a rule that locks or scans a table over `big_table_rows` becomes a blocker, and says the row count.
- **Unparsed.** A statement that matches no rule is not a finding. It is listed as not checked, and the verdict cannot be `safe`. The same goes for anything the splitter cannot be sure it cut right: a psql `\` line, everything after a MySQL `DELIMITER`, and everything after a string with a backslash before a quote.
- **Not SQL.** In a Rails, Alembic, Knex or Django migration only the destructive calls are recognised; the file as a whole is listed as not checked.
- **Infrastructure.** These rules read added and removed lines. A declaration that moved to another line or file is not a removal; a setting on a new resource is not a change; `0.0.0.0/0` in an egress rule is not ingress, and a comment does not decide which it is.

Nothing else changes a rule hit: not the agent, and not Jev.

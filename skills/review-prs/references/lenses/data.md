# Lens: data

Schema, migrations and the data they touch.

- **Destructive changes:** dropped or renamed columns and tables, narrowed types, new `NOT NULL` without a default or backfill, a changed unique constraint. Say what happens to existing rows.
- **Deploy order:** a migration the old code cannot run against, or new code that needs a migration that has not run. Is the change safe in both orders?
- **Locks and size:** an index built without `CONCURRENTLY` on a large table, a rewrite of a big table inside one transaction, a backfill with no batching.
- **Integrity:** missing foreign keys, cascades that delete more than intended, a default that hides a missing value.
- **Row-level security:** a new table with no policy, or a policy that does not match the table's tenant column.
- **Reversibility:** no down migration where the repository writes them; data that cannot be restored after the change.
- **Seeds and fixtures:** production data shapes hard-coded into a migration.

A destructive or irreversible change is written in full sentences: what is lost and when.

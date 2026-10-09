# Setup: writes `.claude/check-infra-and-migrations.json`

Every repo keeps its migrations and its infrastructure somewhere else and applies them its own way. Setup records that once per repo.

It runs in two cases:

- `/real-skills:check-infra-and-migrations setup`, at any time, to create or change the file.
- **The first run in a repo** where `start` returns `setup` in `needs`. Say so in one line and run the steps below. The user may answer "not now": the run goes on with what `probe` found, and you say that.

Look facts up; ask only for decisions. **One** question round, with the detected value as the recommended option.

## 1. Look up

```bash
printf '%s' '{"repo":"<absolute repo root>"}' | $H probe
```

| Field | Becomes the recommended answer for |
|---|---|
| `reuse` | Keys another file already answers (`release` from `.claude/changelog.json` or `.claude/wtf.json`; `environments`, `production_hosts` and `hosting` from `.claude/wtf.json` or `.claude/qa-this.json`). **Do not ask for these and do not copy them**: they are read from there |
| `migrations[]` | The migration tool and its folder, with the file that gave it away |
| `infra[]` | The infrastructure tool and its paths |
| `migration_applied_by[]`, `infra_applied_by[]` | The workflow or package script that runs the tool's apply command |
| `pipeline[]` | Deploy workflows |
| `env_files[]` | Env example files. Names only, never a value |
| `targets[]` | Which branch feeds which environment |

Then read the workflow `probe` named, to answer one thing it cannot: **do migrations run before or after the new code goes live?**

## 2. Ask (one round)

| Key | Question | Notes |
|---|---|---|
| `migrations` | Is this where migrations live, and is this the tool? | "This repo has none" is an answer: write `[]`, and the skill stops asking |
| `migrations[].applied` | When do they run: `before_deploy`, `after_deploy`, or `manual` (a person runs them)? | Recommend what the workflow shows. It decides which side of the deploy a change can break |
| `infra` | Is this the infrastructure code, and is this the tool? | Same: `[]` for none |
| `targets` | Which branch deploys to which environment? | A PR into a listed branch is read as a promotion to that environment |
| `live` | Do you want it to read the real environment? Optional | See below. Skipping it is fine: the verdict then says what it could not check |

Defaults that need no question: `post: "ask"`, `big_table_rows: 1000000`, `jev: "shadow"`. Mention them once.

### Live reads

Three optional commands per environment name. Each is a shell string the harness runs from the repo root, only after the user agrees in that run. **Never guess one, and never write a credential into the file.** Show the template for the detected tool and let the user fill it in.

| Key | Must print | Templates |
|---|---|---|
| `applied` | One applied migration per line: a file name, a version of four digits or more, or a content hash. Print only that column: a short stray value is ignored, and an empty list is reported as not checked | Drizzle: `psql "$RO_URL" -At -c 'select hash from drizzle.__drizzle_migrations'` · Supabase: `psql "$RO_URL" -At -c 'select version from supabase_migrations.schema_migrations'` · Prisma: `psql "$RO_URL" -At -c 'select migration_name from _prisma_migrations where finished_at is not null'` · Rails: `psql "$RO_URL" -At -c 'select version from schema_migrations'` · Alembic: `psql "$RO_URL" -At -c 'select version_num from alembic_version'` |
| `sizes` | `table<TAB>rows` per line. `-1` (never analyzed) is taken as unknown, not as empty | Postgres: `psql "$RO_URL" -At -F '<TAB>' -c 'select relname, reltuples::bigint from pg_class where relkind = $$r$$'` (an estimate is enough) |
| `plan` | The tool's own plan output | CDK: `pnpm --dir infra cdk diff --no-color` · Terraform: `terraform -chdir=infra plan -no-color -lock=false` |

Say these things when asking:

- **Use credentials that can only read.** That is the real boundary. The harness refuses a command that contains a write word (`deploy`, `apply`, `push`, `migrate`, `up`, `destroy`, `upgrade`, `import`, `drop`, `delete`, `truncate`, `reset`, `insert`, `update`, `alter`), alone or in forms like `db:migrate` and `delete-db-instance`, which catches a paste mistake and nothing more. It cannot see what a command does.
- **Put the connection string in an environment variable and name the variable.** Never a password or a URL with one in this file.
- **Reading production is allowed here, and it is the point**: which migrations production has run, and how big its tables are. The harness says "this reads production" before every such run and waits for a yes.
- **`plan` runs the repository's own code** (a CDK app is a program). The harness runs it only when the working tree is clean and already at the head of the change, and it never checks anything out. Do not configure `plan` in a repository whose pull requests you would not run on your machine.
- Raw output is kept in the run folder under `~/.claude/state/check-infra-and-migrations/` and is not pruned. Plan output can hold resource names and whatever the tool prints.
- Parsed today: `cdk diff` and `terraform plan`. Another tool's plan can be configured and is kept, and the verdict will say nobody read it.

## 3. Write

Write `.claude/check-infra-and-migrations.json` with only the keys that were asked. Show the file, then:

```bash
printf '%s' '{"repo":"<absolute repo root>","args":["setup"]}' | $H start
```

`config_sources` shows which file answers each key, and `needs_setup` is now false. A `live` command the guard refuses fails here with the reason. Then continue with what the user asked for.

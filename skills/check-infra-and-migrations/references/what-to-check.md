# What to read for

The harness already did the part a script can do: every statement classified, the migration history checked, removed resources and weakened guards found. Do not repeat that. Read for what needs a reader, and cite every finding at `file:line` with a quote: the harness drops a finding whose citation does not hold.

Open the files under `head_dir`, and the code they touch at the head of the change (`git show <head_sha>:<path>`; never check the change out).

## Migrations

**Two releases done as one.** A safe schema change expands first and contracts later:

1. Add the new column or table. Deploy code that writes both.
2. Backfill.
3. Deploy code that reads the new one.
4. Drop the old one, in a later release.

A change that renames in place, or adds and drops in the same release, skips steps. Say which step is missing and what breaks in between.

**Code and schema out of step.** The harness tells you when migrations run (`applied`).

- `before_deploy`: old code runs against the new schema until the deploy finishes. Anything dropped, renamed or made stricter breaks old code. Look at what the old code writes, not only what it reads: a new `NOT NULL` column breaks every insert that does not know about it.
- `after_deploy`: new code runs against the old schema first. Find the code in this change that needs a column or table the migration adds, and say what it does when the column is not there yet.
- `manual`: both, and somebody has to remember.

**A `still_referenced` hit.** The harness found the dropped or renamed name elsewhere at the head. Open each hit. A real use (a query, a type, a serializer) is a blocker and you cite that line. A comment, a test fixture or an unrelated word with the same spelling is nothing: say so in chat.

**Data changes inside a schema migration.** An `UPDATE` or `INSERT … SELECT` over a large table holds its transaction for as long as it runs, and locks taken earlier in the same file are held with it. Say what it locks and suggest a separate, batched step.

**No way back.** For each destructive statement: is there a backup step, and does the down-migration (if the tool has one) really restore anything? A down that recreates an empty column restores nothing.

**What `unparsed` hides.** A `DO` block, a procedure call, raw SQL inside a Rails or Knex migration. Read it and say what it does. It stays "not checked" for the verdict; your reading is what the user gets instead.

**Idempotence.** If the tool can re-run a migration after a partial failure, `CREATE` without `IF NOT EXISTS` fails the second time.

## Infrastructure

The diff rules are pattern matches. They see a removed declaration; they do not see what the provider does.

**Replacement the diff does not show.** In CloudFormation and CDK, changing a construct's id, moving it to another stack or scope, or changing an immutable property (a database's identifier, engine, encryption, subnet group; a bucket's name; a table's keys) deletes the resource and creates a new, empty one. Terraform: any argument documented as "forces replacement". If the change touches one of these and no plan was read, say so and name the property.

**Order between infrastructure and code.** New code that needs a queue, a secret or a permission that the infrastructure change creates: which deploys first? A removed permission that old code still uses during the rollout?

**Secrets and variables.** A variable the code now reads (`process.env.X`, `os.environ["X"]`) that no service definition, workflow or env example sets. A secret name that changed.

**Blast radius.** A change in a shared stack or module (network, DNS, certificates, a deploy role) reaches every service that depends on it. Name them.

**Access.** New ingress, a wider IAM statement, a bucket policy, a public flag. Write these in full sentences: who can now reach what.

**The pipeline itself.** A deploy workflow that changed in the same release as the thing it deploys: a wrong step is found out only while deploying. Say what changed in the order of steps, especially where migrations run.

## Writing a finding

- `severity`: `blocker` when data is lost or the release cannot apply cleanly; `risk` when it can break running code, lock a busy table or take something down; `note` for a runbook step with no danger in it.
- `problem`: one or two full sentences, cause then consequence. No fragments: it is posted on the PR, and a compressed data-loss warning is a defect.
- `step`: what a person does, in the imperative, with its phase: `before`, `order`, `after` or `rollback`.
- Cite the line that proves it. For "code still uses the column", cite the code, not the migration.
- You can add. You cannot remove or lower a rule hit: disagreement goes in chat, marked as yours.
- No finding is a fine result. Do not invent one to look thorough.

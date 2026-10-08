# Setup: writes `.claude/qa-this.json`

Every repo is tested and run differently. Setup records that once per repo.

It runs in two cases:

- `/real-skills:qa-this setup`, at any time, to create or change the file.
- **The first run in a repo** where `start` returns `setup` in `needs`. `missing` lists exactly what no config file answers. Say so in one line and run the steps below. The user may answer "not now": go on with what exists, and say which methods that rules out.

Look facts up; ask only for decisions. **One** question round, with the detected value as the recommended option.

## 1. Look up

```bash
printf '%s' '{"repo":"<absolute repo root>"}' | $H probe
```

| Field | Becomes the recommended answer for |
|---|---|
| `reuse` | Keys another file already answers (`.claude/wtf.json`, `.claude/changelog.json`). **Do not ask for these and do not copy them**: they are read from there |
| `tests[]` | The test commands, per suite (`unit`, `e2e`), with the dependency or file that gave each away |
| `test_globs[]` | Where test files live, most common first |
| `database_vars[]` | Names of database variables in the repo's example env files. Names only |
| `local[]` | Files that describe a local environment |
| `missing` | What to ask |

Then check what **this session** can reach: a connector or signed-in CLI for the tracker, and whether the database command would run.

## 2. Ask (one round)

Only the rows whose key is in `missing`, plus `databases` if the user wants data checks.

| Key | Question | Notes |
|---|---|---|
| `tracker` | Which tracker holds the tickets? GitHub Issues, ClickUp, Linear, other, none | Then the adapter's **Setup** section in `trackers/<type>.md`. "None" is written down, so the skill stops asking |
| `environments`, `production_hosts` | Which non-production environments exist, and which hosts are production? | **Without `production_hosts` nothing that touches an environment will run**: no browser, no request, no query. List every production host, regional ones included |
| `tests` | The command for unit tests, the command for end-to-end tests, and where test files live | A command takes test file paths as arguments: `pnpm vitest run`, `npx playwright test`. `globs` is what allows new tests to be written; leave it out and none are |
| `databases` | How is a read-only query run on each environment? | See below. Optional |

Defaults that need no question: `post: "ask"`, `screenshots: false`, `report_dir: "docs/qa"`, `jev: "shadow"`. Mention them once.

### The database command

`how` is a shell command that reads one SQL statement on stdin and prints rows, one per line, columns separated by a tab or `|`:

```json
"databases": [{ "env": "local", "how": "psql \"$DATABASE_URL\" -At -F '\t'", "header": false }]
```

Say these three things when asking:

- The harness refuses anything that is not one `SELECT`, and refuses any environment that is not allowed. **It cannot see where your command points.** Point it at a non-production database.
- Use a database user that can only read. The statement filter is a filter on text, not a sandbox.
- Put the connection string in an environment variable and name the variable in the command. Never write a password into this file.

`"header": true` when the first line of output is column names; then the report can name them.

## 3. Write

Write `.claude/qa-this.json` with only the keys that were asked. Show the file, then:

```bash
printf '%s' '{"repo":"<absolute repo root>","args":["setup"]}' | $H start
```

`config_sources` shows which file answers each key. Then continue with what the user asked for.

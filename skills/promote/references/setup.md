# Setup: writes `.claude/promote.json`

Every repo feeds its environments its own way: which branch deploys where, and which environment is promoted into which. Setup records that once per repo. `/promote` never guesses it, because the guess decides what gets merged into production.

It runs in two cases:

- `/real-skills:promote setup`, at any time, to create or change the file.
- **The first run in a repo** where `start` returns `setup` in `needs`. Say so in one line and run the steps below. There is no "not now": without the file nothing is promoted.

Look facts up; ask only for decisions. **One** question round, with what `probe` found as the recommended option.

## 1. Look up

```bash
printf '%s' '{"repo":"<absolute repo root>"}' | $H probe
```

| Field | Use |
|---|---|
| `stages[]` | The proposed stage list, in order, each with `why`: the evidence behind that line. This is the recommended answer |
| `lineage[]` | "N of the last M merges on this branch came from that one": the strongest evidence for `from` |
| `workflows[]` | Deploy workflows, the branches each runs on, the environments each names |
| `hosting[]` | Provider files found (`vercel.json`, `netlify.toml`, `render.yaml`, …) |
| `reuse` | Keys another file already answers (`release` from `.claude/changelog.json`, `.claude/wtf.json` or `.claude/check-infra-and-migrations.json`; `environments`, `production_hosts`, `hosting` from `.claude/wtf.json`, `.claude/qa-this.json` or `.claude/check-infra-and-migrations.json`). **Do not ask for these and do not copy them**: they are read from there |
| `known_targets` | Branch → environment as `.claude/check-infra-and-migrations.json` has it. Already used for the proposed names |
| `suggestions` | Only when a Jev question is switched on for this machine: another reading, to show next to the proposal |
| `note`, `config_error` | One environment branch only, or an existing file that does not load |

`probe` reads names: branches, workflow files, their trigger branches. It cannot know what a host does outside the repo (Vercel's production branch, a Render auto-deploy setting). Say that when the evidence for a line is only the branch name.

## 2. Ask (one round)

Show the proposed stages as a short list (`env` ← `branch`, `how`, `from`) with the `why` for each, then ask:

| Key | Question | Notes |
|---|---|---|
| `stages` | Is this how code moves between your environments? | Offer the proposal first. The user may rename an environment, reorder, add or remove a stage |
| `stages[].how` | For each environment: does it follow its branch (`push`), is it promoted by a pull request from the stage before it (`pr`), or does it get code another way (`manual`)? | `manual` covers a tag, a release, a workflow someone starts, a provider button. Its optional `command` is shown to the user at promotion time and **never run** |
| `stages[].production` | Which environment do real users use? | Recommend the one `probe` marked. A promotion into it carries "this deploys to production" at both questions |
| `stages[].merge_method` | How are promotion pull requests merged: `merge`, `squash` or `rebase`? | Default `merge`. Recommend `merge`: a squashed promotion makes the next one conflict, because the target no longer contains the source's commits |
| `stages[].deploy_workflow` | Which workflow file deploys this environment? Optional | On the source stage it is the run that proves the environment ran the exact commit. On the target stage it is the run `watch` waits for. Leave it out where the host deploys by itself (Vercel, Netlify, Render): GitHub deployments of the commit are used instead. Where the deploy runs in Actions and no file is named, `watch` has nothing to go on: no other workflow run counts as a deploy |
| `verify` | Should it check what is running after a promotion? Optional | See below |

Defaults that need no question: `jev: "shadow"`. Mention it once.

### `verify`

Per environment name, both optional:

| Key | What | Template |
|---|---|---|
| `health` | An http(s) URL that answers 2xx when the environment is up. Requested once, with GET, after the deploy | `https://app.example.com/api/health` |
| `deployed` | A shell command of the user's that prints the commit the environment is running **now, and no other commit**. The promotion counts as verified when the output names the promoted commit (7 or more characters of it, as a whole word) and no other commit id. A list of past releases names several, and is reported as not checked | An app that reports its version: `curl -fsS https://app.example.com/api/version` · AWS ECS, image tagged with the commit: `aws ecs describe-task-definition --task-definition <family> --query taskDefinition.containerDefinitions[0].image --output text` · Fly: `flyctl image show -a <app>` · a list command cut down to its first line: `<list command> \| head -1` |

Say these things when asking about `deployed`:

- **Never guess one, and never write a credential into the file.** Name an environment variable instead.
- **Use credentials that can only read.** That is the real boundary. The harness refuses a command that contains a write word (`deploy`, `apply`, `push`, `migrate`, `up`, `destroy`, `upgrade`, `import`, `drop`, `delete`, `truncate`, `reset`, `insert`, `update`, `alter`, `promote`, `rollback`, `merge`), which catches a paste mistake and nothing more. It cannot see what a command does.
- It usually reads production. The harness shows the command and waits for a yes on every run.
- Its raw output is kept in the run folder under `~/.claude/state/promote/` and is not pruned.

Skipping `verify` is fine: a promotion then ends as `promoted_unverified`, which says the deploy finished green and nobody checked what is running.

## 3. Write

Write `.claude/promote.json` with only the keys that were asked. Example: [`config.example.json`](../config.example.json). Show the file, then:

```bash
printf '%s' '{"repo":"<absolute repo root>"}' | $H configured
```

It prints the stages as the harness reads them, `promotable` (the environments that can be promoted to) and `warnings`. An invalid file fails here with the key and the reason: fix it and call `configured` again. `labelled` is the number of Jev cases the confirmed stages just answered; nothing to do about it.

`.claude/check-infra-and-migrations.json` reads `stages` as its `targets` when it has none of its own, so the same answer serves both skills.

Then continue with what the user asked for.

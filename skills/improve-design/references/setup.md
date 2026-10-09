# Setup: writes `.claude/improve-design.json`

A design pass has to run the app from its own worktree and check that each change still builds. Setup records how, once per repo.

It runs in two cases:

- `/real-skills:improve-design setup`, at any time, to create or change the file.
- **A run whose `start` lists `dev` or `gates` in `setup_needed`.** Say what that costs in one line (no `dev`: nothing is looked at on screen and the result is unverified; no `gates`: nothing checks that a change still builds) and offer the steps below. "Not now" is allowed.

Look facts up; ask only for decisions. **One** question round, with the detected value as the recommended option.

## 1. Look up

```bash
printf '%s' '{"repo":"<absolute repo root>"}' | $H probe
```

| Field | Becomes the recommended answer for |
|---|---|
| `suggest.dev` | `dev.install` and `dev.command`, from the package manager and the `dev` script. `{port}` is filled in by the run: the command must accept it |
| `suggest.gates` | `gates`, from the check scripts in `package.json` (type-check, lint) |
| `suggest.copy` | `dev.copy`: env files that exist here and that git ignores. Names only; setup never reads one |
| `reuse` | `production_hosts`, when another skill's config already lists them. Do not ask and do not copy |
| `impeccable` | `null` means the impeccable plugin is not installed. Say so and stop: the skill cannot run without it |
| `gh` | `false` means runs need `--no-pr` |
| `missing` | What to ask |

In a monorepo, ask which app: `dev.cwd` is its folder, and `probe` reads that folder's `package.json`.

## 2. Ask (one round)

| Key | Question | Notes |
|---|---|---|
| `dev` | How is the app installed and started, on a port the run picks? | The run starts its own server from its own worktree. A server you already have running serves another tree and is never used |
| `dev.copy` | Which ignored files does the app need to start? | Usually `.env.local`. Copied into the worktree, never read, never printed, removed when the run stops. A file git tracks or does not ignore is refused |
| `gates` | Which commands must stay green after every change? | Fast ones: each runs after every move. A full end-to-end suite here makes a six-move run slow |
| `ui_paths` | Which files may a design move change? | The default is every component, style and asset file. Narrow it to the app's own folders to keep moves out of shared packages |

Defaults that need no question: `base` (the repo's default branch), `viewports` (`1440x900` and `390x844`), `max_moves: 6`, `screenshots: false`, `pr.draft: "auto"`, `jev: "shadow"`. Mention them once.

`capture` is only worth asking about when the screen needs a signed-in session a script can have, for example a Playwright command with saved storage state. It is a shell command with `{url}`, `{out}`, `{width}` and `{height}`. Without it the run uses the repo's Playwright, then a Chrome on the machine, then an agent in the browser pane.

## 3. Write

Write `.claude/improve-design.json` with only the keys that were answered. [config.example.json](../config.example.json) shows every key. Then say whether the file should be committed: it holds no secret, and committing it gives every teammate and every worktree the same setup.

## 4. Check

Run `probe` again. `missing` should be empty. Do not start a dev server to prove the command: the first run does that and says plainly when it fails.

# real-skills

Skills for everyday engineering work, packaged as one plugin, `real-skills`. Install once, get every skill. Works in Claude Code and Codex. `do-shit` needs Claude Code.

| Command | What it does |
|---|---|
| `/real-skills:do-shit <refs…> [--dry-run]` | Takes GitHub issues, ClickUp tasks or Linear issues to merged PRs: investigator plans, role-based subagent teams in isolated worktrees, a deterministic harness, one PR per leaf, gated merge, optional QA with evidence. Also `resume <run-id>` and `status [<run-id>]`. |
| `/real-skills:changelog [technical\|non-technical] [--releases N] [--days N]` | Changelog for the last N releases (promotion PRs into a production branch, or git tags). Every PR gets a short summary and its tracker ticket, then an "In progress" section of recently opened tickets. Read-only. |
| `/real-skills:changelog setup` | Detects the release model, asks which tracker you use (GitHub Issues, ClickUp, Linear, none, or any other tracker with an MCP connector), derives the ticket-ID pattern from recent PRs, and writes `.claude/changelog.json`. Runs automatically on first use. |
| `/real-skills:ask-and-create-specs [goal]` | Interview that ends in a spec an agent can implement from: caveman-terse, hard-capped at 40 lines per file. Jev decides which questions reach you (the rest are dropped or logged as assumptions), when to stop asking, one spec vs index + slices, and which lines get cut. Writes `docs/specs/` and `CONTEXT.md` glossary terms. User-invoked only. |
| `/real-skills:quick-ask-me [goal]` | Short interview for quick tasks: objective, observable success criteria, then at most 6 questions that change what gets built. Writes `CONTEXT.md` glossary terms and rare ADRs as it goes, ends with a brief. User-invoked only. |

## Install

### Claude Code

```bash
claude plugin marketplace add jpcasa/real-skills
claude plugin install real-skills@jpcasa-skills
```

Or inside a session: `/plugin marketplace add jpcasa/real-skills`, then `/plugin install real-skills@jpcasa-skills`. Start a new session afterwards. Commands are prefixed with the plugin name: `/real-skills:changelog`.

### Codex

```bash
npx skills add jpcasa/real-skills -a codex
```

This copies the skills into Codex's skills folder. Invoke them as `/changelog`, `/quick-ask-me` and `/ask-and-create-specs`. The repo also ships Codex plugin manifests (`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`) for plugin-aware installs.

### Support

| Skill | Claude Code | Codex |
|---|---|---|
| `changelog` | ✓ | ✓ (tracker connectors must be configured in Codex too) |
| `quick-ask-me` | ✓ | ✓ |
| `ask-and-create-specs` | ✓ | ✓ (Jev needs the full plugin layout; otherwise it runs its by-hand rules) |
| `do-shit` | ✓ | ✗: needs Claude Code subagents, plugin agents and hooks; stops with a message elsewhere |

## Requirements

- Node 20+, `git`, `jq`, `gh` (authenticated)
- Tracker access, only for the trackers you use:
  - **GitHub Issues:** `gh`
  - **ClickUp:** a ClickUp MCP connector (e.g. the claude.ai ClickUp connector)
  - **Linear:** a Linear MCP connector; `do-shit` uses [Composio](https://composio.dev)'s `linear` toolkit
- **Jev (optional, `do-shit` and `ask-and-create-specs`):** a [TypeSafe](https://typesafe.ai) API key in `TYPESAFE_API_KEY`, or the macOS keychain item `typesafe-api`. Without it `do-shit` runs in its conservative fallback and `ask-and-create-specs` judges by hand. Request bodies are redacted (`hooks/lib/redact.jq`) before they leave the machine and never include source code. `ASK_SPECS_JEV=0` turns it off for `ask-and-create-specs`.

## Layout

```
.claude-plugin/
  marketplace.json      marketplace "jpcasa-skills"
  plugin.json           plugin "real-skills" (root of this repo)
.codex-plugin/plugin.json             Codex plugin manifest
.agents/plugins/marketplace.json      Codex marketplace manifest
skills/                 each skill also has agents/openai.yaml (Codex display + invocation policy)
  do-shit/              orchestrator skill + harness (scripts/harness.mjs)
  changelog/            skill + release-ranges.sh + tracker adapters
  quick-ask-me/         skill + CONTEXT/ADR formats
  ask-and-create-specs/ skill + Jev judgments (scripts/spec-jev.mjs; reuses do-shit's Jev client)
agents/                 17 do-shit role agents, spawned as real-skills:<role>
hooks/                  hooks.json + guard-roles.mjs
```

## do-shit notes

- **Role guard.** `hooks/hooks.json` runs `guard-roles.mjs` on Bash/Edit/Write calls. It acts only on `real-skills:<role>` agents: read-only roles can't edit or run mutating commands, build roles edit only inside `.claude/worktrees/ds-*` and their `allowed_paths`, and no role pushes or stashes. Your other agents are untouched.
- **Overrides.** A same-name agent in `<repo>/.claude/agents/` or `~/.claude/agents/` replaces the bundled role. Plugin agents can't declare hooks, but repo and user agents can: add the guard to their frontmatter if you want it.
- **Per-repo config** in `<repo>/.claude/do-shit.json` (all keys optional): `verify`, `base`, `statuses`, `labels`, `path_rules`, `allowed_paths`, `spawn_cap`, `max_concurrent_teams`, `merge_method`, `pr_title`.
- **Run state** lives in `~/.claude/state/do-shit/` (override with `DO_SHIT_STATE_DIR`).
- **Jev calibration** (`skills/do-shit/scripts/eval/run.mjs`) needs fixtures from your own PRs in `scripts/eval/fixtures/`. They are gitignored.

## ask-and-create-specs notes

- **Jev decides, code owns thresholds.** `spec-jev.mjs` has four stateless commands: `triage` (ask / assume / drop per question), `gate` (stop interviewing), `shape` (single vs sliced, optional sections), `lint` (line cap, structure, dead and duplicate lines). Thresholds in `T` are uncalibrated defaults.
- **What is sent.** The goal, candidate questions, the brief and spec lines. Never source code.

## changelog notes

To add a tracker, add `skills/changelog/references/trackers/<type>.md` with **Setup**, **Ticket ID** and **In progress** sections, then list it in `references/setup.md`.

## Develop

```bash
claude plugin validate . --strict
node --test skills/*/scripts/test/*.test.mjs
bash skills/changelog/scripts/test/release-ranges.test.sh
```

## License

MIT. `skills/quick-ask-me` and `skills/ask-and-create-specs` build on [mattpocock/skills](https://github.com/mattpocock/skills) (MIT): their interview style follows `grill-with-docs`, the glossary format follows `domain-modeling`, and `references/CONTEXT-FORMAT.md` and `references/ADR-FORMAT.md` are adapted from `domain-modeling`.

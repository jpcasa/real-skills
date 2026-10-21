# clean-slop + ponytail pillar Plan

Spec: `docs/specs/2026-10-21-clean-slop.md`
Goal: `/real-skills:clean-slop` strips branch slop under green checks; ponytail rule in every code skill.
Verify: `env -u NODE_USE_SYSTEM_CA node --test skills/*/scripts/test/*.test.mjs`
Constraints:
- Node 20+, zero deps, one JSON object per CLI call, realpath `isMain` guard
- Copied files kept identical by `skills/do-shit/scripts/test/sync.test.mjs`

## File map
| File | Responsibility |
|---|---|
| `skills/do-shit/references/code-style.md` | ponytail rule source, plus agent block |
| `skills/clean-slop/scripts/slop.mjs` | `start`, `check`, `commit` |
| `skills/clean-slop/scripts/lib/cuts.mjs` | pure `never_cut`, `doc_fact`, `grew` detection |
| `skills/clean-slop/SKILL.md`, `references/slop.md` | agent flow, slop catalogue |

## Tasks

### Task 1: code-style pillar
Files: `skills/do-shit/references/code-style.md` (create), 9 copies, 10 `SKILL.md`, 8 `agents/*.md`, `sync.test.mjs`, `agents.test.mjs`
Covers: D7,D8 · Parallel: no · Review: no
- [ ] Failing test: copies identical; listed agents contain the agent block verbatim
- [ ] Implement: rule file, copies, one line per SKILL.md, block per agent
- [ ] Run: `env -u NODE_USE_SYSTEM_CA node --test skills/do-shit/scripts/test/{sync,agents}.test.mjs` → pass
- [ ] Commit: `feat: add ponytail code-style rule to code skills and agents`

### Task 2: clean-slop harness
Files: `skills/clean-slop/scripts/slop.mjs`, `scripts/lib/{cuts,flags,glob}.mjs`, `scripts/test/slop.test.mjs` (create)
Covers: D1–D6 · Parallel: no (after 1) · Review: no
- [ ] Failing test: temp repo; start scope, dirty refusal, red-after block, flags, commit refusals and commit
- [ ] Implement: harness; copy fix-ci `flags.mjs`, do-shit `glob.mjs`; add to sync lists
- [ ] Run: `env -u NODE_USE_SYSTEM_CA node --test skills/clean-slop/scripts/test/*.test.mjs` → pass
- [ ] Commit: `feat(clean-slop): add harness`

### Task 3: skill docs, README, release
Files: `skills/clean-slop/{SKILL.md,agents/openai.yaml,config.example.json,references/slop.md}`, `README.md`, manifests
Covers: D9,D10 · Parallel: no (after 2) · Review: no
- [ ] Implement: SKILL flow over harness; README rows, section, pillar; `0.15.0`
- [ ] Run: `claude plugin validate . --strict` → pass; Verify → pass
- [ ] Commit: `feat: add clean-slop skill, release 0.15.0`

## Execution
- This session, task order; a task is done only with its `Run:` output.
- One whole-branch review at the end (`/code-review`).
- Last: the `Verify:` command, output cited.

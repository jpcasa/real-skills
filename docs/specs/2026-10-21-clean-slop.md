# clean-slop + ponytail pillar

Goal: `/real-skills:clean-slop` strips slop a branch added, checks stay green, one local commit; ponytail rule in every code skill.

## Done when
- [ ] `node skills/clean-slop/scripts/slop.mjs start` lists branch-changed files vs merge-base, with added line ranges; paths narrow it; `--all <path>` takes whole files
- [ ] `start` refuses a dirty tree and the base branch; runs gates once as baseline
- [ ] `check` blocks an unlisted or out-of-scope file, a moved HEAD, a gate green before and red after
- [ ] `check` flags fix-ci shortcuts: test removed or skipped, suppression, check config, deps
- [ ] `check` flags `never_cut` (removed validation, error handling, auth, a11y), `doc_fact` (URL or code cut from prose), `grew`
- [ ] `commit` refuses without a fresh `check`; flags or no gates need `--confirmed`; commits only listed files, never pushes
- [ ] `skills/do-shit/references/code-style.md` copied into 9 skills; `sync.test.mjs` keeps copies identical
- [ ] build + plan agents carry code-style's agent block verbatim; `agents.test.mjs` checks it
- [ ] README, manifests list clean-slop and the ponytail pillar; version `0.15.0`
- [ ] `env -u NODE_USE_SYSTEM_CA node --test skills/*/scripts/test/*.test.mjs` green

## Decisions
- Default target: branch diff vs merge-base — slop lands with the branch
- Output: one local commit after green checks — never push
- Slop = code + prose (comments, docstrings, docs in scope)
- Ponytail as bundled rule, writers + planners — no plugin dependency, works in Codex

## Assumed
- No Jev in v1: no question has data yet, catalog untouched
- Gates: `.claude/clean-slop.json` `gates`, else solve-merge-conflicts, improve-design, do-shit `verify`
- Writers: do-shit, fix-ci, solve-merge-conflicts, improve-design, qa-this, clean-slop. Planners: create-spec, create-plan, ask-and-create-specs, quick-ask-me
- Agents: worker, data-engineer, test-engineer, integrator, designer, observability-engineer, investigator, architect
- Flag copy of fix-ci `flags.mjs`, not a shared import — skills ship as single folders

## Out of scope
- Push, PR, worktree, `status`/`drop` commands
- Review lenses for lean code (review-prs, auditor)

## Seam
- `start`/`check`/`commit` exported from `slop.mjs` · `skills/clean-slop/scripts/test/slop.test.mjs`

---
name: create-spec
description: "Write a terse spec an implementing agent can build from, from a goal, a /quick-ask-me brief, a /wtf verdict, a ticket or the conversation. Sizes the work first (no spec, a few lines in chat, or a file), asks at most one round of questions only the user can answer, and writes caveman-terse spec files capped at 40 lines and checked by a script. Jev scores which questions to ask, whether a file is needed, the shape and dead lines. Never implements. Use when the user invokes /create-spec or asks for a spec, or when another skill hands off to it."
argument-hint: "[goal | brief | ticket ref] [--file]"
---

# Create Spec

A spec says what gets built and how it is checked. Nothing else. Every line must change what gets built or tested; the rest misleads the implementer.

Never implement from here. Write, hand off, stop.

## Harness

`S` = this skill's directory (`${CLAUDE_PLUGIN_ROOT}/skills/create-spec` in Claude Code). `H` = `node "$S/../ask-and-create-specs/scripts/spec-jev.mjs"`, shared with `/ask-and-create-specs`. Commands: `size`, `triage`, `shape`, `lint`; JSON out.

- **`by_hand: true` → harness did not decide: apply that step's By hand rule.** Jev off (`degraded: true`: say once, no retry) or uncalibrated (default). Never act on `shadow`. Harness missing → every step By hand.
- Code always stands: `size` tier 2, `lint` structure rules.
- `ASK_SPECS_JEV`: unset `shadow`, `live`, `0`/`off`. Sends goal, questions, brief, spec lines to `api.typesafe.ai`, redacted. Never source code or secrets.

## 1. Brief

Read code, `CONTEXT.md`, existing specs first. Facts you can look up are never questions; collect as `known`. Brief: `goal`, `done_when[]`, `decisions[]`, `assumed[]`, `out_of_scope[]`, `seam`. A full brief from a caller (`/ask-and-create-specs`, `/quick-ask-me`) skips step 3.

| Source | Maps to |
|---|---|
| Free goal (`$ARGUMENTS`, conversation) | `goal`; rest from code + step 3 |
| `/quick-ask-me` brief | Objective → `goal` · Success criteria → `done_when` · Decisions · Assumed without asking → `assumed` · Out of scope · Seam |
| `/wtf` `DEFECT` | expected → `goal` · failing step → `done_when` · cited `file:line` → `known` |
| `/wtf` `FEATURE_REQUEST` | the ask → `goal` · `searched` → `known` |
| Ticket | title + description → `goal` · acceptance criteria → `done_when` |
## 2. Size

```bash
echo '{"goal":"…","files_guess":["…"],"touches":["auth","schema"]}' | $H size
```

`tier: 0` → no spec: say `Tier 0 — no spec: <rule>`, stop or return to caller. `tier: 1` → spec in chat, ≤10 lines, same headings, skip steps 4 and 6. `tier: 2` → file. `--file`, or the user asked for a file → tier 2. **By hand:** raise to 2 for a new subsystem, a changed shared interface, or several independent behaviours. Never lower a code tier 2.

## 3. One question round

List every open question with your `recommended` answer; add done-when, scope edge and seam if the brief lacks them.

```bash
echo '{"goal":"…","known":["…"],"questions":[{"id":"q1","question":"…","recommended":"…"}]}' | $H triage
```

`drop` → forget. `assume` → recommendation into `assumed`. `ask` → ask. `verdict: null` → By hand. Ask every `ask` in ONE structured-question call (AskUserQuestion), max 4, recommended option first. Over 4 → keep the 4 costliest to guess wrong, assume the rest. No second round; if it truly needs an interview, hand off to `/real-skills:ask-and-create-specs`. A brief field still empty after the round → your best guess, listed in `assumed`. **By hand:** `drop` when no answer changes code, tests or scope. `ask` when only the user can know it, or a wrong guess is expensive (data, public interface, auth, payments, deletion). Else `assume`.

## 4. Shape

```bash
echo '<brief json>' | $H shape
```

`single` → `docs/specs/YYYY-MM-DD-<slug>.md`. `sliced` → `docs/specs/YYYY-MM-DD-<slug>/README.md` (index) + `01-<slice>.md`…, each buildable and verifiable from index + own file. `sections`: the optional sections allowed; no others. Repo has its own spec location → use it. **By hand:** single unless the cap forces slices; optional section only when the work clearly touches it.

## 5. Write

```md
# <title>

Goal: <one line>

## Done when
- [ ] <command, test, or observable behaviour>

## Decisions
- <decision> — <reason, few words>

## Assumed
- <auto-decided, not asked. Override if wrong>

## Out of scope
- <adjacent thing not being done>

## Seam
- `<interface tests exercise>` · <test path>
```

Optional, only when `shape` picks them, before `## Seam`: `## Data` (tables, columns, migrations, policies), `## UI` (screens, components, states), `## Interfaces` (signatures, endpoints, events, config keys), `## Rollout` (flag, backfill, deploy order), `## Risks` (security, money, privacy, irreversible). Exact names.

Index (`README.md`, sliced only): `# <title>`, `Goal:`, `## Slices` (`- [01-<slice>.md](./01-<slice>.md) — <outcome> · after: <none | NN>`), `## Shared` (decisions or interfaces every slice relies on).

- **40 non-blank lines per file, hard.** Over → cut, then slice. Never raise the cap.
- Full caveman: no articles, filler, hedging. Fragments. One fact per line. Exact paths, identifiers, commands, error strings in backticks. Never paraphrase.
- No background, motivation, history, alternatives, or implementation steps (that is `/create-plan`).
- `CONTEXT.md` terms as-is; never redefine one. Empty `## Decisions` / `## Assumed` → delete heading. Code only as a signature or shape, ≤5 lines.
- **Full prose, not caveman,** for `## Risks` lines and any line where a dropped word could change meaning (ordered or irreversible steps).

## 6. Lint

```bash
$H lint docs/specs/<file>.md            # sliced: README.md and every slice
```

Fix, re-run; at most 2 passes, then list what is left in the handoff.

| Rule | Fix |
|---|---|
| `over_cap` | Cut; still over → slice |
| `no_goal`, `missing_section`, `empty_section` | Add it, or delete the empty heading |
| `long_line`, `duplicate` | Split to one fact per line; cut the duplicate |
| `not_checkbox`, `not_checkable` | `- [ ] <command, test or behaviour that proves it>` |
| `dead_line` | Cut, unless you can say what an implementer does differently because of it |

**By hand** (`by_hand`): per line, "would the implementer build or check anything differently without this?" No → cut. `shadow` entries are not problems.

## Handoff

Print, then stop (a calling skill continues from here):

```md
Spec: <path(s) | in chat>
Tier <n> · asked <n> · assumed <n> · dropped <n> · lines <n>
Assumed (override if wrong): <one line each, or "none">
Unresolved lint: <problems, or "none">
Next: /real-skills:create-plan <path>
```

---
name: ask-and-create-specs
description: Short interview that ends in a spec an implementing agent can run from without drowning in context. Jev judgments decide which questions reach the user, when to stop asking, whether to write one spec or slices, and which lines get cut. Specs are caveman-terse, hard-capped at 40 lines per file. User-invoked only.
argument-hint: "[goal]"
disable-model-invocation: true
---

# Ask and Create Specs

Interview, then write a spec. Long specs confuse the agent that implements them, so every line must change what gets built or how it is checked. Everything else dies.

Never implement from inside this skill. Write the spec, print the handoff, stop.

## Harness

`S` is this skill's directory. The harness is `node "$S/scripts/spec-jev.mjs" <command>`.

Four commands, JSON out. `triage`, `gate` and `shape` read JSON on stdin; `lint` takes file paths. Code owns thresholds; Jev only scores. You write all text.

Every result has `degraded`. `degraded: true` means Jev was unreachable (no TypeSafe key, `ASK_SPECS_JEV=0`, timeout, or the skill was installed without the rest of the plugin). Then apply the **By hand** rule for that step. Say once in chat that Jev is off; do not retry.

Privacy: the goal, your candidate questions, the brief and spec lines are sent to `api.typesafe.ai`, token-shaped strings redacted first. Never put source code or secrets in harness input.

## 1. Context first

Read the relevant code, `CONTEXT.md` (or the context named by `CONTEXT-MAP.md`), existing specs and recent commits. A fact you can look up is never a question. Collect what you learn as `known`: short strings, one fact each.

## 2. Goal

One question: restate the goal in one sentence, ask to confirm or correct. Use `$ARGUMENTS` if given.

## 3. Interview loop

Keep a running **brief**: `goal`, `done_when[]`, `decisions[]`, `assumed[]`, `out_of_scope[]`, `seam`.

Each round:

1. List every open question you can think of, each with your `recommended` answer. Include done-when, scope boundary and seam if the brief lacks them.
2. Triage:
   ```bash
   echo '{"goal":"…","known":["…"],"questions":[{"id":"q1","question":"…","recommended":"…"}]}' | node "$S/scripts/spec-jev.mjs" triage
   ```
   - `drop`: forget it.
   - `assume`: take your recommendation, add one line to `assumed`. Do not ask.
   - `ask`: put it to the user with your recommendation.
3. Ask the `ask` questions. Independent ones together, at most 4, with the host's structured-question tool (AskUserQuestion in Claude Code) or a numbered list. A question that depends on another's answer waits for the next round. Caveman wording; no preamble.
4. Fold answers into the brief. Term resolved → write it to `CONTEXT.md` now (see Glossary).
5. Gate:
   ```bash
   echo '{"goal":"…","done_when":["…"],"decisions":["…"],"assumed":["…"],"out_of_scope":["…"],"seam":"…"}' | node "$S/scripts/spec-jev.mjs" gate
   ```
   `stop: true` → step 4. Otherwise the next round targets `missing` only (`goal`, `done_when`, `out_of_scope`, `seam`, or `open_fork`: an approach choice still undecided).

After 3 rounds without `stop`, show the brief in ≤8 lines and ask once: "Write spec, or keep going?"

**By hand** (triage): `drop` when no reasonable answer changes code, tests or scope. `ask` when only the user can know it, or a wrong guess is expensive to undo (data, public interface, auth, payments, deletion). Else `assume`.
**By hand** (gate): stop when the goal is one concrete outcome, every done-when is pass/fail, one out-of-scope item is named, the seam names an interface and a test location, and no approach fork is open. Hard cap: 6 questions after the goal.

## 4. Shape

```bash
echo '<brief json>' | node "$S/scripts/spec-jev.mjs" shape
```

- `shape: "single"` → one file: `docs/specs/YYYY-MM-DD-<slug>.md`
- `shape: "sliced"` → a folder: `docs/specs/YYYY-MM-DD-<slug>/README.md` (index) plus `01-<slice>.md`, `02-<slice>.md`… Each slice is a full spec an agent can implement and verify alone, reading only the index and its own file.
- `sections`: the optional sections to include. Any section not listed must not appear.

Use the repo's existing spec location if it has one.

**By hand:** single, unless the draft cannot fit the cap; then slice. Add an optional section only when the work clearly touches it.

## 5. Write

Spec file:

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

Optional sections, only when `shape` picks them, placed before `## Seam`:

- `## Data`: tables, columns, migrations, policies. Exact names.
- `## UI`: screens, components, states. Exact names.
- `## Interfaces`: signatures, endpoints, events, config keys. Exact shape.
- `## Rollout`: flag, backfill, deploy order.
- `## Risks`: security, money, privacy, irreversible steps.

Index file (`README.md`, sliced only):

```md
# <title>

Goal: <one line>

## Slices
- [01-<slice>.md](./01-<slice>.md) — <outcome> · after: <none | NN>

## Shared
- <decision or interface every slice relies on>
```

Rules:

- **40 non-blank lines per file, hard.** Over → cut, then slice. Never raise the cap.
- Full caveman: no articles, filler or hedging. Fragments. One fact per line.
- Exact paths, identifiers, commands, error strings in backticks. Never paraphrase them.
- No background, motivation, history, or alternatives considered. No implementation steps: that is the plan's job.
- Use `CONTEXT.md` terms as-is. Never redefine one in the spec.
- Empty `## Decisions` or `## Assumed` → delete the heading.
- Code only as a signature or shape, ≤5 lines.
- **Full prose, not caveman,** for any `## Risks` line and any line where word order or a dropped word could change meaning (ordered steps, irreversible actions). Clarity beats the token.

## 6. Lint, then save

```bash
node "$S/scripts/spec-jev.mjs" lint docs/specs/<file>.md            # sliced: pass README.md and every slice
```

Fix every problem, re-run. At most 2 fix passes; anything left, list it under the handoff.

| Rule | Fix |
|---|---|
| `over_cap` | Cut lines; still over → slice |
| `no_goal`, `missing_section`, `empty_section` | Add it, or delete the empty heading |
| `long_line` | Split: one fact per line |
| `not_checkbox` | `- [ ] <check>` |
| `not_checkable` | Name the command, test or behaviour that proves it |
| `dead_line` | Cut. Keep only if you can say what an implementer does differently because of it |
| `duplicate` | Cut one |

Structure rules run without Jev. **By hand** (when `degraded`): reread each line and ask "would the implementer build or check anything differently without this?" No → cut.

## Glossary

Vocabulary only, in `CONTEXT.md`. Create it lazily, on the first resolved term. If `CONTEXT-MAP.md` exists, write to the context it points at.

- User's term conflicts with `CONTEXT.md` → say so, settle it, counts as an `ask` question.
- Vague or overloaded term → propose one canonical word.
- Entry format:
  ```md
  **Term**:
  One sentence: what it is.
  _Avoid_: synonym, synonym
  ```
- Project-specific terms only. No implementation detail, no decisions, no ADRs.

## Handoff

Print, then stop:

```md
Spec: <path(s)>
Asked <n> · assumed <n> · dropped <n> · lines <n>
Assumed (override if wrong): <one line each, or "none">
Unresolved lint: <problems, or "none">
```

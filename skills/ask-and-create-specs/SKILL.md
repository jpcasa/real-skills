---
name: ask-and-create-specs
description: Short interview that ends in a spec (written by /create-spec) an implementing agent can run from without drowning in context. Jev judgments decide which questions reach the user, when to stop asking, whether to write one spec or slices, and which lines get cut. Specs are caveman-terse, hard-capped at 40 lines per file. User-invoked only.
argument-hint: "[goal]"
disable-model-invocation: true
---

# Ask and Create Specs

Interview, then write a spec. Long specs confuse the agent that implements them, so every line must change what gets built or how it is checked. Everything else dies.

Never implement from inside this skill. Write the spec, print the handoff, stop.

Scope follows rule 1 of [references/code-style.md](references/code-style.md) (ponytail): what nobody asked for is out of scope, not a question.

## Harness

`S` is this skill's directory. The harness is `node "$S/scripts/spec-jev.mjs" <command>`.

Five commands, JSON out. `triage`, `gate`, `shape` and `size` (used by `/create-spec`) read JSON on stdin; `lint` takes file paths. Code owns thresholds; Jev only scores. You write all text.

Every result has `by_hand`. **`by_hand: true` means the harness did not decide: apply the By hand rule for that step.** Two things cause it:

- `degraded: true`: Jev was unreachable (no TypeSafe key, `ASK_SPECS_JEV=0`, timeout, or the skill was installed without the rest of the plugin). Say once in chat that Jev is off; do not retry.
- Jev answered, but its thresholds are not calibrated yet, or the run is not `live`. This is the default today. The result still carries `scores` and a `shadow` field (what the scores would have decided). Those are a log for calibration, not an instruction: do not act on `shadow`.

What code checks without Jev always stands, whatever `by_hand` says: empty brief fields in `gate`, and the structure rules in `lint`.

Modes, from `$ASK_SPECS_JEV`: unset is `shadow` (Jev is asked and logged, By hand decides), `live` (calibrated thresholds decide), `0` or `off` (Jev is never called). Every answered call is appended to `~/.claude/state/ask-and-create-specs/jev.jsonl`.

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
   - `verdict: null` (with `by_hand: true`): the harness did not decide this one. Use the By hand rule below.
3. Ask the `ask` questions. Independent ones together, at most 4, with the host's structured-question tool (AskUserQuestion in Claude Code) or a numbered list. A question that depends on another's answer waits for the next round. Caveman wording; no preamble.
4. Fold answers into the brief. Term resolved → write it to `CONTEXT.md` now (see Glossary).
5. Gate:
   ```bash
   echo '{"goal":"…","done_when":["…"],"decisions":["…"],"assumed":["…"],"out_of_scope":["…"],"seam":"…"}' | node "$S/scripts/spec-jev.mjs" gate
   ```
   `stop: true` → step 4. Otherwise the next round targets `missing` only (`goal`, `done_when`, `out_of_scope`, `seam`, or `open_fork`: an approach choice still undecided). With `by_hand: true` and an empty `missing`, every field is present and the stop decision is yours: use the By hand rule.

After 3 rounds without `stop`, show the brief in ≤8 lines and ask once: "Write spec, or keep going?"

**By hand** (triage): `drop` when no reasonable answer changes code, tests or scope. `ask` when only the user can know it, or a wrong guess is expensive to undo (data, public interface, auth, payments, deletion). Else `assume`.
**By hand** (gate): stop when the goal is one concrete outcome, every done-when is pass/fail, one out-of-scope item is named, the seam names an interface and a test location, and no approach fork is open. Hard cap: 6 questions after the goal.

## 4. Write the spec

The spec format, shape, write rules and lint belong to `/real-skills:create-spec`. Read `$S/../create-spec/SKILL.md` and follow its steps 4 (Shape), 5 (Write) and 6 (Lint) with this brief. Skip its steps 1–3: the interview replaced them. A brief this full is tier 2: always a file.

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
Next: /real-skills:create-plan <path>
```

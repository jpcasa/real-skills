---
name: calibrate
description: Checks the Jev questions this plugin's skills log but do not yet act on, against what turned out to be right, and switches on the ones that earned it, on this machine only. Shows progress per question, collects right answers from the user for logged cases, and applies or revokes a question after the user approves it. User-invoked only.
argument-hint: "[status] | label [<skill>[/<question>]] | apply | revoke <skill>/<question>"
disable-model-invocation: true
---

# Calibrate

The skills in this plugin ask Jev small yes/no questions and get a number back. For most of those questions the number is logged and ignored: nobody has checked whether it can be trusted. This skill is that check.

```
skills log cases ──► right answers (automatic, or you label them) ──► the bar ──► you approve ──► the question decides
                                                                                              └─► spot checks keep it honest
```

**It changes one file**, `~/.claude/state/calibration/calibration.json`, and only after the user says yes to a named question. It makes no network call and edits no skill.

```bash
H="node ${CLAUDE_SKILL_DIR:-<this skill's folder>}/scripts/calibrate.mjs"
```

Every command prints one JSON object. If Node is missing, say so and stop: there is nothing to do by hand here.

## Arguments

| Argument | Do |
|---|---|
| none, or `status` | `$H status`, then the Status report below |
| `label [<skill>[/<question>]]` | The Labeling round below |
| `apply` | The Apply steps below |
| `revoke <skill>/<question>` | `$H revoke --question <skill>/<question>`, then say what it now does: asks again, as before |

## Status

```bash
$H status            # or: $H status --skill wtf
```

One line per question, grouped by skill. Lead with the totals.

```
<skill>/<question> · <status> · <labeled>/<cases> labeled (<true> yes, <false> no) · threshold <current> → <proposed> · acts on <act_rate>
```

| `status` | Meaning | Say |
|---|---|---|
| `not enough data` | Under 30 labeled cases, or under 5 of one answer | What `need` says is missing. If `cases` is larger than `labeled`, offer `label` |
| `no safe threshold` | Every threshold would have made the unsafe error at least once | That this question stays off, and that more cases will not fix it by themselves |
| `never acts` | A safe threshold exists, but it would act on under one case in ten | That turning it on would change almost nothing |
| `ready` | The bar is met | The proposal, and offer `apply` |

`deciding` is set on a question that is already switched on. `revoked` lists questions switched off during this call because a right answer showed the unsafe error: name each one and the case.

Most questions will say `not enough data` for weeks. That is the honest state, not a failure. Do not suggest lowering the bar.

## Labeling round

```bash
$H label-next                                  # or --skill <s>, --question <q>
```

`cases` holds up to 12 logged cases with no right answer yet. For each: `show` is what was judged, `ask` is the question about it. **The score is not included, on purpose.** Do not look it up, and do not guess the answer for the user.

Ask the user, four cases per question round, each with three options: **Yes**, **No**, **Can't tell**. Put `show` in the question text exactly as given. A `spot: true` case is a spot check on a question that is already deciding: say so.

Then record what they answered, and only that:

```bash
printf '%s' '{"labels":[{"skill":"changelog","question":"area","case":"<case>","answer":"yes"}]}' | $H label
```

`answer` is `yes`, `no` or `cant_tell`. "Can't tell" writes nothing. If `revoked` comes back non-empty, tell the user plainly: that question was deciding, this answer showed it deciding wrongly on the unsafe side, and it is now off.

`unshowable` counts cases with no text to show (for example `wtf`, whose log holds no report text; its right answers come from `/real-skills:wtf outcome`). `remaining` says how many more are waiting. Offer another round; never label without the user.

## Apply

1. `$H status`. List the `ready` questions. If there are none, say so and stop.
2. For each one, show: what the question decides, the proposed threshold, `labeled` and the split, and every case in `near` (the ones closest to the threshold). When `bound` is present, say it in words: "no unsafe error in N cases; the real rate could still be up to about `bound`".
3. Ask the user **per question**: switch it on, or not. One question round, one option pair per question.
4. Apply only what they approved:

```bash
printf '%s' '{"questions":["wtf/ask_not_breakage"]}' | $H apply
```

The script recomputes the bar and refuses anything that is not `ready`, whatever it is handed. Report `applied` and `refused` as returned.

5. Say what changes: that question now decides in `live` mode on this machine; in `shadow` (the default for most skills) it still only logs. Name the skill's switch for `live`.

## What keeps a switched-on question honest

- **Spot check.** One decision in ten is still put to a person, picked by a hash of the case so it is repeatable. That is where new right answers come from once the skill has stopped asking.
- **Auto-revoke.** One right answer on the unsafe side switches the question off, immediately. Switching it back on needs the bar met again, with that case counted.
- **Off switch.** `REAL_SKILLS_CALIBRATION=off` makes every skill ignore the file.

## What this can never switch on

`do-shit`'s merge approval and QA approval, every code veto, and `wtf`'s verdict rules. They are not Jev questions and have no entry to write. If the user asks for one, say it is not available and why.

## Guardrails

- Never write `calibration.json`, a log or a label by hand. Only through `$H`.
- Never label a case yourself, and never fill in an answer the user did not give.
- Never apply a question the user did not approve by name in this conversation.
- Never describe a `ready` question as proven. Use the numbers.

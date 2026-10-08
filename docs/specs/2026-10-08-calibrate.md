# calibrate: let logged Jev questions earn the right to decide

Date: 2026-10-08 · Branch: `jpcasa/calibrate-spec` · Ships as `/real-skills:calibrate`, plugin `0.4.0`

## Goal

23 Jev questions across five skills are logged and decide nothing, because nobody has checked them against what was right. `calibrate` is the missing step: it collects a right answer for each logged case, measures each question against a fixed bar, and, with the user's approval per question, lets that question decide on this machine.

## Where things stand (measured 2026-10-08)

| Skill | Uncalibrated questions | Logged cases today | Right answer available today |
|---|---|---|---|
| `do-shit` | 2 (`plan_needs_human_review`, `fix_stays_within_item_scope`) | 0 with a Jev score. 26 checkpoint and 1 re-approval answers exist, all from runs before the questions were added | The user's gate answer, once runs log a score beside it |
| `wtf` | 3 | 2 | `outcome right|wrong`, 1 so far |
| `changelog` | 3 | 0 | None |
| `quick-ask-me` | 5 | 0 | None |
| `ask-and-create-specs` | 10 thresholds | 0 | None |

So the first deliverable is not a threshold. It is the logging and labeling that make one possible. Nothing can be calibrated on day one, and the skill must say that plainly.

## Decisions taken

- **Applied locally first.** A calibrated question is recorded in a file on this machine. No release, no reinstall, one command to undo. Shipping thresholds to every installer of the plugin is out of scope here.
- **Labels from a labeling session**, plus natural labels wherever the skill already captures the user's answer.
- **Strict bar on the risky side** (below).

## Terms

- **Case**: one time a question was asked about one thing (a plan, a PR, a candidate question).
- **Label**: what the right answer for that case was, `true` or `false`.
- **Unsafe error**: the error that removes a human check or drops information. Each question has exactly one unsafe direction. The other error only costs an unnecessary ask.

## Non-goals

- Changing `THRESHOLDS` or `UNCALIBRATED` in the repo, or opening PRs. A later `promote` command may do that.
- Calibrating `do-shit`'s original questions; they have their own fixture eval (`scripts/eval/run.mjs`).
- Touching what is never automatic: `merge_approval`, `qa_approval`, every code veto, `wtf`'s verdict rules. Calibration only changes whether a Jev score is used where the code already allows one.
- Replaying old cases through Jev to create scores after the fact. It would re-send stored text; cases accumulate from normal use instead.
- Sending anything new to Jev. `calibrate` makes no API calls.

## Approach

### A. One log record shape, written by every skill

Each skill appends to its own `~/.claude/state/<skill>/jev.jsonl` (for `do-shit`, the run's `events.jsonl`), one record per question per case:

```json
{"v":1,"type":"case","skill":"changelog","question":"changes_live_behaviour_without_opt_in",
 "case":"<repo>#412","p":0.81,"threshold":0.5,"acts_when":"gte","unsafe":"fn",
 "fallback":false,"show":"PR #412: tighten session timeout to 15 min","ts":"..."}
```

- `acts_when`: `gte` or `lt`, the side of the threshold on which the question changes the outcome.
- `unsafe`: `fp` or `fn`, which error is the unsafe one for this question.
- `fallback`: what the code or model decided without Jev.
- `show`: at most 300 characters, already redacted, taken from what was sent to Jev. Enough for a person to recognise the case. `wtf` writes no `show`: its log holds no report text, and it needs none because its labels come from `outcome`.

`calibrate` reads only these records, so it needs no copy of any skill's question list.

Choice-type questions (`changelog`'s `area`) log `choice` and `confidence`; the label is whether the choice was right.

### B. Labels

A label is `{case, skill, question, label, source, ts}`. A person's labels go to `~/.claude/state/calibration/labels.jsonl`; a label a skill can derive is written by that skill into its own log, so `calibrate` needs no per-skill knowledge.

| Source | Skills | How |
|---|---|---|
| `gate` | `do-shit` | Checkpoint answered "proceed" with no exclusions, re-plans or notes: review was not needed (`false`). Anything else: `true`. Re-approval approved: fix stayed in scope (`true`) |
| `outcome` | `wtf` | From `outcome`: the final verdict set gives each question's answer (`FEATURE_REQUEST` present: `ask_not_breakage` true; `KNOWN`/`ALREADY_FIXED` citing that ticket: `same_issue` true; `USER_ERROR` without the messaging `DEFECT`: `screen_was_enough` true). `wrong` with no `--actual` gives no label |
| `answer` | `quick-ask-me` | New `gate.mjs answered`: the user picked something other than the recommended answer, so `answer_changes_what_gets_built` is `true`; picked it, `false` |
| `human` | all | `/real-skills:calibrate label [skill[/question]]`: shows up to 12 unlabeled cases, four per question round, each with `show`, the question in plain words, and Yes / No / Can't tell. "Can't tell" writes nothing |

Cases nearest the threshold are shown first: they move the result most.

### C. The bar

A question may decide when all hold, computed by the script from logs and labels:

1. At least 30 labeled cases, at least 5 of each label.
2. A threshold exists with **zero unsafe errors** in the sample. Among those that act most often, take the middle one, never less than one step (0.05) from the unsafe side. A question with no unsafe side (it only adds strictness when it acts) is chosen on accuracy.
3. At that threshold it acts on at least one case in ten. A question that never acts is not worth turning on.

The report states what zero-in-`n` proves and no more: with 30 clean cases the true unsafe rate may still be up to about 10% (3/`n`). At 100 cases, 3%.

### D. Applying it

`/real-skills:calibrate` (no argument) prints, per question: cases, labeled, split, current threshold, proposed threshold, unsafe errors, how often it would act, and one of `not enough data`, `no safe threshold`, `ready`. For `ready` questions it lists every case that sits within 0.1 of the proposed threshold.

`apply` asks once per ready question, then writes `~/.claude/state/calibration/calibration.json`:

```json
{"v":1,"questions":{"changelog/changes_live_behaviour_without_opt_in":
  {"threshold":0.6,"n":41,"labels_sha":"…","applied":"2026-11-02"}}}
```

Each skill reads it through a small `lib/calibration.mjs` (identical copy per skill, pinned by `sync.test.mjs`): a question is calibrated when it is not in `UNCALIBRATED`, or it has an entry here; the entry's threshold replaces the built-in one. `REAL_SKILLS_CALIBRATION=off` ignores the file. Mode rules are unchanged: a calibrated question still decides only in `live`.

`revoke <skill/question>` removes the entry.

### E. Staying calibrated

Once a question decides, the human is no longer asked, so labels stop. Two rules keep it honest:

- **Spot check.** One live decision in ten (chosen by a hash of the case id, so it is repeatable) is still put to the user, marked as a spot check, and labeled.
- **Auto-revoke.** Any label that makes a live decision an unsafe error removes the entry at once and logs why. Re-applying needs the bar met again, with that case in the sample.

### Rejected alternative

**Treat agreement with the fallback as proof.** No effort, and it was available on day one. But a question that always agrees with the code adds nothing, and one that disagrees is exactly the case where someone has to say who was right. It measures copying, not correctness.

## Interfaces and data changes

- New: `skills/calibrate/` (`SKILL.md`, user-invoked only, `scripts/calibrate.mjs` with `status | label-next | label | apply | revoke`, tests).
- Changed, all five skills: the case record (A); `lib/calibration.mjs` reader; `quick-ask-me` gains `gate.mjs answered`; `do-shit` logs a case beside each checkpoint and re-approval answer.
- New state: `~/.claude/state/calibration/{labels.jsonl,calibration.json}`.
- Existing test hooks (`*_TEST_CALIBRATED`) stay.

## Risks

- **Slow start.** 30 cases per question at current use is weeks for `do-shit` and `wtf`, longer for the rest. Mitigation: `status` shows progress per question; labeling works on whatever exists.
- **Thirty clean cases is weak evidence.** Stated in the report with the bound. Spot checks and auto-revoke are what catch the rest.
- **Labels are relayed by the model.** The script records what it is handed; a fabricated label would be accepted. Mitigation: labels come through a visible question round, `human` labels carry the session time, and one bad live decision revokes.
- **`show` text in logs.** Redacted, 300 characters, same text already sent to Jev. `wtf` writes none.
- **A hand-edited `calibration.json` is trusted.** It is the user's file; treated as their decision.
- **Machine-local tuning.** Thresholds from one person's repos may not suit another's. That is why nothing is shipped from here.

## Verification

```bash
node --test skills/*/scripts/test/*.test.mjs
bash skills/changelog/scripts/test/release-ranges.test.sh
claude plugin validate . --strict
```

New tests: the bar (29 cases fails, 4 of one label fails, one unsafe error at every threshold gives `no safe threshold`, the chosen threshold has the safety step applied); natural-label mapping per source; `label` ignores "can't tell"; `apply` refuses a question that is not `ready` and recomputes instead of trusting its input; every skill's reader honours the file, the off switch, and `shadow` mode; spot check is deterministic at one in ten; an unsafe label on a live decision revokes; `merge_approval` and `qa_approval` cannot be reached by any entry in the file; sync test covers the reader copies.

Then one real pass: run `status` against this machine's logs and confirm it reports `not enough data` for all 23, with the right counts.

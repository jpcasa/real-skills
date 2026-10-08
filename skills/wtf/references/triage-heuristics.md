# Triage heuristics — defect vs. user error

Read when the verdict is not obvious from the code path alone. These are general. A repo can add its own in the file named by `heuristics` in `.claude/wtf.json`; where the two disagree, the repo's file wins, because it was written from that product's own history.

## The prior

Reports from a support channel usually arrive labelled urgent and labelled "bug". Neither label is evidence. A large share turn out to be one of:

1. **A guard working correctly.** The user hit a deliberate block and read it as breakage. "This button should have no blockers" is a request to remove a guard, not a report that the guard is broken. The verdict depends on whether the guard's *condition* is right, not on whether a guard exists.
2. **Wrong screen or wrong control.** The action exists, one page over, or under a role the user does not hold.
3. **State the flow requires.** The control is disabled because a prerequisite is unmet, and the screen never says which. **This is often a real defect**: a disabled control with no stated reason is a copy and affordance bug even when the block itself is correct. Split the verdict: logic correct, messaging defective.
4. **Test or demo data.** Shared environments carry seeded rows. "A test record came up when I searched" is data hygiene, not a code defect, unless search really is matching the wrong field.
5. **Deploy skew.** Fixed on the main branch, not yet released. `wtf.mjs skew` answers this; always run it before calling something a live defect.

## The counter-prior

Do not over-apply the above. Real defects hide behind ordinary-sounding reports. Each of these is a flag for the harness, and each one vetoes `USER_ERROR`:

| Flag | What you observed in the code or the report |
|---|---|
| `enabled_noop` | A control that renders enabled and does nothing when pressed |
| `wrong_data_shown` | Wrong data displayed. A user cannot mis-click their way into a bad read |
| `silent_write_noop` | The user saves, gets no error, and the value is gone on reload |
| `worked_before_unchanged_flow` | "It worked last week" and the user's workflow did not change. That points at a deploy |

Raise a flag only for what you saw: the handler, the write path, or the report's own account. A flag is a claim until a citation backs it.

## Separating them

Ask, in order:

1. **Is there a code path that produces exactly what the user saw?** Yes and intentional: lean `USER_ERROR`. Yes and unintentional: `DEFECT`. No path produces it: the premise may be wrong; check whether the feature exists at all.
2. **Did the product tell them?** A correct block with no explanation is a defect in the message, even when the logic is right.
3. **Could a competent user have got it right from what was on screen?** If not, the screen is the defect.
4. **Is the ask "let me do X" rather than "X is broken"?** `FEATURE_REQUEST`.

## Evidence that settles it

- The guard's condition, read from source, with the exact predicate (role `guard`).
- The enabled/disabled logic for the control they pressed, and its handler (role `handler`).
- The mutation's write path: does the field they changed actually reach storage? (role `write_path`).
- `skew` on a recent fix.
- A reproduction on a non-production environment.

## Evidence that does not settle it

- The ticket's own category or priority.
- The reporter's theory of cause. People report symptoms accurately and causes badly.
- A runtime error that merely correlates in time.
- The absence of a runtime error. Silent no-ops throw nothing.
- A reproduction that did not reproduce. It may have used different data, a different role, or a different build.

## Writing user-error guidance

The reader is not an engineer. Numbered steps, real on-screen labels taken from the source, no file paths, no jargon. Close with the one-sentence reason their approach did not work.

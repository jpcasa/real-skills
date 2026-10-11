# From issues to moves

The critic lists issues. The harness turns them into moves. A move is one issue (or several on the same element), one impeccable command and one intent line, small enough that a comparison of two pictures can say whether it helped.

## What the critic returns per issue

| Field | Rule |
|---|---|
| `severity` | `P0` blocks a task, `P1` causes real difficulty, `P2` is an annoyance, `P3` is polish. impeccable's own scale |
| `element` | One element or region, named the way a person would point at it: "Save button", "pricing table header". Two issues naming the same element and command become one move |
| `problem` | One line: what is wrong and who it hurts. This is the line the comparing critic is given, so it must make sense without the source |
| `fix` | One line: what to do. It becomes the designer's intent |
| `command` | One impeccable command. `alt` is a second choice, only when there is a real one |
| `source` | `detector` when the finding came from the detector output in the prompt, `audit` for a technical check, `critique` for a judgment |
| `files` | Repo-relative paths. An issue that names only files outside the repo is refused |
| `visual` | `false` only when a fix changes nothing a sighted person sees |

## Two kinds of command

| Kind | Commands | At the checkpoint | Under `--auto` |
|---|---|---|---|
| `refine` | `polish`, `layout`, `typeset`, `clarify`, `distill`, `harden`, `adapt`, `optimize`, `onboard` | Ticked | Runs |
| `shift` | `bolder`, `quieter`, `colorize`, `animate`, `delight`, `overdrive` | Listed, not ticked | Skipped and listed |

A `refine` move keeps the look the screen has. A `shift` move changes its direction, and that is the user's call: it runs when they tick it, or when it was asked for with `--direction`.

## Order

1. Ranked by severity, then by who found it: the detector, then the audit, then the critique.
2. Cut at `max_moves`. What is cut is listed, never dropped silently. A move asked for with `--direction` is never cut.
3. Run order: every `refine` move first, then every `shift` move. A direction change that gets rejected then costs nothing that came before it.

Each move starts from what the moves before it left: a kept move stays in, a dropped one is gone before the next begins.

## What a designer may touch

Only files matching `ui_paths`, and only for this one move. A designer who sees another problem reports it; it does not fix it. Logic, data fetching, validation and state shape are out of bounds: a commit that touches a file outside `ui_paths` is taken off the branch whatever it looked like.

# How a move is judged

Every move is judged twice: by checks a script runs, and by a comparison a critic makes without knowing which side is new. Either can drop it. Nothing can keep a move both did not approve.

## The checks

Run by `move-check`, on the designer's commits:

- **Scope.** Every changed file matches `ui_paths`. A file that was moved counts under its old name too.
- **Gates.** Each configured command, run again. A gate that was green before this move and is not green now is a veto. A gate that was already red is not this move's doing, and is not counted against it.
- **Detector.** The changed files are written out as they were before the move and as they are after it, and impeccable's detector scans both the same way. A finding that was not there before is a veto. Advisory findings never count. If the detector did not run, that is not a pass: the move may stay, marked as not fully checked, and the run is `unverified`.
- **A commit, and nothing left over.** No commit, a `blocked` report, or uncommitted files are each a veto.

A vetoed move is not compared. Its commits come off the branch and its patch is saved.

## The comparison

For a move with something to see:

1. The harness takes pictures at every viewport and pairs each with the picture of the screen before the move.
2. Pictures that are byte for byte the same are `same` without asking anyone. If every pair is, the move changed nothing on screen and is dropped.
3. The rest are copied to a temporary folder as `X` and `Y`. Which is which is random per pair, and the key stays with the harness.
4. A fresh `design-critic` is told the problem and shown the pairs. It answers, per pair: `X`, `Y` or `same`, one line on what each shows, and anything broken with the side and the place.
5. The harness turns `X` and `Y` back into before and after.

The move is dropped when the before picture was preferred at any viewport, when something broken was named on the after side with a place, or when every pair came back `same`. It is kept when after was preferred at least once and never lost.

Every configured viewport has to be answered for. One whose picture failed, or whose pair the critic did not answer, keeps the move from counting as seen: it stays, marked, and the run is `unverified`.

`same` at one viewport and preferred at another keeps the move and makes the run `mixed`.

For a move with nothing to see, there is no picture to compare. It is kept when the detector saw its finding go, or when a critic points at a real `path:line` that shows the problem gone. Otherwise it is dropped.

## Taking a move off the branch

The patch is written to the run folder first. Then the branch is moved back to where the move started, and only when all of these hold:

- the worktree is the run's own;
- the tip is that move's last commit;
- nothing is uncommitted;
- the branch has never been pushed.

If one does not hold the harness stops and says which. Do not move the branch by hand.

## What blind means, and what it does not

The critic's prompt and pictures carry no hint of which side is newer: neutral names, the same timestamp, a folder outside the run. The role guard also refuses the critic's shell commands that read the run's state file or the branch history, the two places that say which is which. That is a fence, not a proof: the guard sees shell commands and edits, not every file read, so a critic that set out to find the answer could. The agent definition forbids it.

Model scores move by a point between runs. That is why a single move is never judged on scores, only on the pairwise comparison and the checks, and why a one-point drop at the end makes a run `mixed` without taking anything back.

# solve-merge-conflicts: make a conflicted pull request mergeable again

Date: 2026-10-12 · Branch: `jpcasa/solve-merge-conflicts-skill-231e8f` · Ships as `/real-skills:solve-merge-conflicts`, plugin `0.12.0`

## Goal

Add `/real-skills:solve-merge-conflicts`: take a pull request that conflicts with its base, read what landed on the base and what the pull request did (commits, their pull requests, their tickets), resolve every conflict so that both intents survive, run the repo's checks, and push the result to the pull request branch after one yes. A script lists the conflicts, applies every resolution, checks each claim it can check, runs the checks and makes the push; the agent reads both sides and proposes the resolution.

It sits beside `review-prs`: a pull request that cannot merge is fixed here, then reviewed or merged elsewhere.

## Decisions taken (asked 2026-10-12)

- **Write scope:** one push to the pull request branch, after one yes. Refused when the pull request head moved, the pull request closed, a check the merge turned red, or a conflict is still undecided. It never merges the pull request and never comments on it.
- **Conflicts where one side must give way:** asked, one question per conflict, with both sides, their commits and a recommendation. Everything the script can show keeps both sides is resolved without a question.
- **Input:** pull requests only, always in the run's own worktree. A merge already stopped in the user's checkout stays with the `resolving-merge-conflicts` skill.
- **Jev:** shadow. Three questions, logged, deciding nothing until `/calibrate` switches one on.

## Assumed (say so if wrong)

- **Merge, not rebase.** The base is merged into the pull request branch: one merge commit, an ordinary push, nobody's commits rewritten. Rebase is a non-goal for v1.
- **One pull request per run.**
- **The main thread resolves.** No new agent; `integrator` stays `do-shit`'s.
- **Same-repo branches only.** A pull request from a fork is refused with the reason.

## Non-goals

- Rebase and force-push. A repo that forbids merge commits on pull request branches is told so, and nothing is written.
- Fork pull requests, hosts other than GitHub, several pull requests in one run.
- Merging, approving, commenting, retargeting or closing the pull request.
- New behaviour. A resolution combines what the two sides wrote. An edit outside a conflict is allowed only to adapt one side to the other's change (a rename, a moved file, a changed signature), and each one is listed.
- Fixing checks that were already red on the pull request before the merge.
- Regenerating migrations. Two sides that both add a migration are flagged, with a pointer to `/real-skills:check-infra-and-migrations`.

## Approach

### 1. Commands

```
/real-skills:solve-merge-conflicts [<pr>] [--no-push]
/real-skills:solve-merge-conflicts status
/real-skills:solve-merge-conflicts drop <run-id>
```

- `<pr>`: a number or a URL. Left out: the pull request of the current branch; if it has none or does not conflict, the user's open pull requests that GitHub marks conflicting are offered and one is asked for, never picked.
- `--no-push`: everything up to the summary. The resolved commit stays in the run's worktree and the push command is printed.
- `status`: runs that still have a worktree, with their verdict. `drop`: removes one run's worktree, and only that.

### 2. Flow

```
start (pull request · base · head · does it conflict?) ──► nothing to solve ──► stop
        │
        ▼
open: worktree at the pull request head, base merged in without committing
        │        conflicts listed, each with its class, its hunks and its sources
        ▼
mechanical first (script): lockfiles and configured generated files
        │
        ▼
per hunk: read both sides and their sources ──► resolve (the script writes the file)
        │                                          └── one side gives way ──► ask ──► decide
        ▼
adapt (only if the merge broke something): edits outside the conflicts, each listed
        │
        ▼
check: nothing unresolved · every claim checked · merge commit · the repo's checks ──► verdict
        │
        ▼
summary in chat ──► YES ──► push (ordinary push, pinned to the head that was resolved)
```

### 3. What "understand the changes" means, in code

`open` returns, per conflicted file, the sources the agent must read before it resolves anything:

- `pr_side`: the pull request's commits since the merge base that touched the file (sha, subject), plus the pull request's title and body.
- `base_side`: the base's commits since the merge base that touched the file, each with the pull request that carried it (number, title) when GitHub knows one.
- `base_since`: what else landed on the base since the merge base: count, and the titles of up to 30 pull requests. Renames and moved files among them are named (`git diff --name-status -M` on the range), because they break pull-request code that does not conflict.

Every resolution that is not mechanical cites at least one commit from each side. The script checks each cited sha is in that side's range and touched that file; a resolution with a citation that fails is refused.

### 4. Conflict classes

Sides are named `pr` and `base` everywhere, never "ours" and "theirs".

| Class | From | Resolved by |
|---|---|---|
| `content` | both modified, or both added | Per hunk, see below |
| `lockfile` | a known lockfile name | Script: the base's version, then the package manager's lockfile-only command with scripts off. Unknown manager, or the command fails: asked |
| `generated` | a `generated` glob in config | Script: the base's version, then the configured command. No command: asked |
| `modify_delete` | one side deleted, the other changed | `keep`, `delete`, or `port` (the change is carried to where the file moved, as a listed edit). `delete` and `keep` are asked |
| `binary` | git says binary | Asked: `pr` or `base` |
| `structural` | rename/rename, rename/add, directory/file | Asked, always |

Hunks are read from the file in `zdiff3` form, so each has three texts: `pr`, `base`, and what both started from. The agent never edits a conflicted file. It sends the resolution and the script writes it:

| Kind | Sent | The script checks | Asked? |
|---|---|---|---|
| `both` | which side goes first | Nothing to check: both texts are written whole | No |
| `combined` | the resolved text | Every identifier and number either side added, compared with where they started, is in the text | Only when one is missing; the missing ones are named |
| `pr`, `base` | nothing | That the dropped side really adds nothing: its text equals the kept side's or the starting text once whitespace is ignored | Yes, unless that holds |

A hunk can be resolved again: the file is rebuilt from the conflicted copy kept in the run folder. `decide --hunk <id> --confirmed` records the user's answer for a hunk that was asked; a resolution changed afterwards needs a new answer.

### 5. Edits outside the conflicts

After every hunk is resolved the agent may edit other files in the worktree, only to adapt one side to the other's change. `check` takes the list (`file`, one-line `why`, the commit that made it necessary) and compares it with what git says differs from the tree the resolutions alone produce. A changed file that is not on the list fails the check; so does a listed commit that is not in either range. Every such edit is shown in the summary.

### 6. Checks and verdict

`check` makes the merge commit itself (message: `Merge <base> into <head>`, body: one line per resolved conflict), then runs the repo's checks in the worktree.

- Where the commands come from: `gates` in `.claude/solve-merge-conflicts.json`, else `gates` in `.claude/improve-design.json`, else `verify` in `.claude/do-shit.json`. `install` the same way (`dev.install` from `improve-design.json`). None found: the verdict says the result was not checked, and so does the push question.
- A red check is run once more on the pull request head as it was. Red there too: the merge did not break it; a warning. Green there: the merge broke it; a block.
- A check killed by a signal is run once more alone before it counts.

| Verdict | Means |
|---|---|
| `nothing_to_solve` | The pull request merges cleanly with its base |
| `resolved` | Every conflict resolved, every claim checked, checks green or red-before |
| `resolved_unverified` | Same, and no check command was found |
| `needs_decision` | A hunk, a file or an edit waits for the user |
| `checks_failed` | The merge turned a check red. The worktree is kept; nothing is pushed |
| `blocked` | A fork, a closed pull request, a moved head, a base that conflicts again |
| `pushed` | The push went through and GitHub's mergeable state was read back |

### 7. Gates

| Gate | Blocks when |
|---|---|
| `pr_open` | The pull request is closed or merged |
| `same_repo` | The head branch lives in a fork |
| `conflicts` | None: ends the run as `nothing_to_solve`, not an error |
| `local_unpushed` | Never blocks. The user's local branch holds commits the pull request lacks: said, because the pull request head is what gets resolved |
| `migrations` | Never blocks. Both sides add a migration: said, with the skill to run |
| `head_unchanged` (`check`, `push`) | The pull request head is no longer the commit the worktree was opened at. The run ends; start again |
| `base_moved` (`push`) | The base moved and the merge commit no longer merges with it. Moved and still clean: a warning |
| `decisions`, `outside_edits`, `checks` (`push`) | Any is not satisfied |

A gate that could not be read is `unknown`, never `pass`; `head_unchanged` blocks when the branches cannot be fetched.

### 8. The one write

`push --run <id> --confirmed`: `git push <remote> <merge sha>:refs/heads/<head>` from the run's worktree. No force flag exists in the script; a head that moved is refused by the script first and by git second. Then it reads the pull request's mergeable state back and removes the worktree. `--confirmed` means a yes to this push in this conversation.

The worktree is detached at the head commit, so it works when the user has that branch checked out elsewhere. After the push the user's own checkout is behind by one commit; the final report says `git pull`.

### 9. Jev

Three questions, all in `UNCALIBRATED`. Each can only add a question for the user; none can resolve a hunk, drop a question or decide the push.

| Question | Asks | Label | Unsafe side |
|---|---|---|---|
| `sides_disagree` | Do the two sides want different things here, so one must give way? | The user's answer when the hunk was asked; otherwise by hand in `/calibrate` | `fn` |
| `resolution_adds_behaviour` | Does this `combined` text or outside edit do something neither side did? | By hand | `fn` |
| `edit_is_adaptation` | Is this outside edit needed because of the other side's change? | By hand | `fp` |

Sent: the file path, the kind, the agent's one-line reason, and each side's commit subjects and pull request titles. Never the code. Off: `"jev": "off"` in `.claude/solve-merge-conflicts.json` or `SOLVE_CONFLICTS_JEV=off`. Catalog 46 → 49.

### 10. Config and state

`.claude/solve-merge-conflicts.json`, all optional: `install`, `gates`, `gate_timeout_s`, `lockfiles` (name → command), `generated` (`[{glob, command?}]`), `jev`. With no file the skill runs on what it finds.

`~/.claude/state/solve-merge-conflicts/<run-id>/`: `run.json`, the conflicted copy of every file, the hunks, check output. It holds other people's code: sensitive, not pruned. `log.jsonl` holds counts and verdicts, no code; `jev.jsonl` the cases and labels. Run ids are `mc-<date>-<time>-<hex>`; the worktree is `.claude/worktrees/<run-id>`.

### 11. Changed by the build (2026-10-12)

- **`both` is also asked when the two sides wrote largely the same new lines** (half or more of the shorter side's lines are in the other). Found on a real pull request: a branch built on an earlier copy of its base, where both sides "added" two versions of one block and writing both would have repeated it.
- **`pr` and `base` are also free when both sides only added lines and the kept side has all of the other's.** Nothing is dropped there.
- Hunks are rebuilt by the script from the three versions of the file (`git merge-file --zdiff3`, a marker longer than any marker-like line in the file). The markers git leaves in the working file are never parsed.
- The merge commit is built with `git commit-tree`. The worktree's HEAD never moves, no hook runs, and a second `check` builds a new commit from scratch.
- The summary is part of what `check` returns, not a command of its own. `push` refuses when the worktree no longer has the tree that was checked.
- Lockfile and generated-file commands run at `check`, after the other conflicts are settled, because they read the manifests. Other files such a command writes are reported as `regenerated`, not as edits.
- An install command that already fails on the pull request head means nothing could be checked: `resolved_unverified`, not a pass.
- A conflict on a submodule pointer is `blocked`.

From the review of the finished harness, same day:

- **Nothing is written or removed through a symbolic link.** A pull request can carry one that points outside the repository. A conflict on one is `blocked`.
- **`pr` and `base` compare whole lines**, however short. The first version skipped lines of three characters or fewer, so `i++` could be dropped unasked. A `combined` text is also asked when it has fewer bracket-only lines (`});`) than a side added.
- **`port` is asked.** git follows a move it can see, so a modify/delete conflict means it could not: where the change belongs is a call.
- **A tracked config file is read as the base branch has it**, a file the pull request adds is not used, and only an untracked file is read from the checkout. The first version read the checkout, which is usually on the pull request's branch.
- **The checks run on the merge commit, in a second worktree** (`<run>-check`). In the run's own worktree, a check that writes untracked files (coverage, build output) would have made the push refuse and the next check list them as edits. An install command alone is not a check.
- **The remote is matched on `owner/name`**, whatever the host is written as. With several remotes and none that matches, `start` stops: the push could have landed in a fork.
- A file taken whole from one side gets that side's mode. A file a lockfile command wrote stays the command's only while it holds what the command left. A dropped run is not opened again. `push` reads the commit's tree and parents back from git. Paths are literal (`pages/[slug].tsx`). A `combined` text keeps a file's Windows line endings.
- A file git reports in conflict whose lines merge (a `-merge` attribute) is resolved whole and asked, as a `binary` one.
- Section 4 says `structural` is always asked. One case is not: a path both sides removed (the old name in a rename on both sides) is deleted, because neither side has it.
- Not changed: `push` takes the remote and the commit from the run file. The state folder is the user's own; someone who can write it can already push.

## Rejected alternative

Let the agent edit the conflicted files and have the script check afterwards that no marker is left. It is what `integrator` and `resolving-merge-conflicts` do, and it is less code. But then "which hunk became what" is the agent's report, not a fact: the script could not check a `both` claim, could not tell a resolution from an edit that added behaviour, and could not show the user exactly what a question is about. Writing the resolution through the script costs one command per hunk and makes every line of the summary something git or the script produced.

## Changes outside `skills/solve-merge-conflicts/`

- `skills/do-shit/scripts/test/sync.test.mjs`: both copy lists, `sets`, count 46 → 49. `skills/calibrate/scripts/lib/catalog.mjs`: three lines. `skills/calibrate/scripts/calibrate.mjs`: the state folder.
- `README.md` (both tables, a section, layout, counts), both `plugin.json` (`0.12.0`, description, keyword), both `marketplace.json`.
- `hooks/guard-roles.mjs`, `agents/`: unchanged.

## Risks

- **Running the checks runs the pull request's code on this machine.** Same trust as checking the branch out, which is why forks are refused and lockfile commands run with scripts off. `SKILL.md` says it at the start.
- **A resolution can be textually right and still wrong.** The identifier check catches a dropped name, not a changed meaning. Every `combined` hunk and every outside edit is shown before the push; the checks are the other net; a repo with no checks gets `resolved_unverified`, in those words.
- **A push to a branch someone else is working on.** One merge commit, never a rewrite, refused on a moved head. Their next `git pull` is a fast-forward.
- **The identifier check will ask too often** on hunks where one side deleted a name on purpose. That is the safe direction; `log.jsonl` counts how often, to tune from.
- **First real push is unverified until someone uses it.** The release note says so.

## Verification

```bash
node --test skills/*/scripts/test/*.test.mjs && bash skills/changelog/scripts/test/release-ranges.test.sh && claude plugin validate . --strict
```

Tests run the harness end to end on temp repos with a `gh` stub (`SOLVE_CONFLICTS_GH_STUB`) and a bare remote: each conflict class, each kind with its check passing and failing, a citation outside the range, an unlisted outside edit, a check red before and red only after, a moved head between `check` and `push`, a base that moved clean and conflicting, a fork, `--no-push`, the push landing on the remote, and that the script contains no force flag.

Live, read-only, 2026-10-12, on echo1 pull request #1836 (a stacked branch, 21 commits behind its base):

- `start` through the command line against real `gh`: the pull request, both heads, 8 conflicted files, 16 pull requests and one rename on the base since the branches parted, no check command found.
- `open`: a worktree at the head, 8 `content` conflicts with 14 hunks, each file's commits on both sides, and the pull request behind every base commit read from GitHub. Then `drop`: the worktree was removed and the checkout was left as it was.
- That run is where the rule about two sides writing the same lines came from (section 11).

Not verified: `resolve` through `push` on a real pull request. Nothing in this work pushed anywhere but the test suite's own bare remotes.

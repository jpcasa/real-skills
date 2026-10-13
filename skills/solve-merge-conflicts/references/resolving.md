# Resolving a conflict

A conflict is two people changing the same place for two reasons. The job is to find both reasons and write the lines that serve both. Picking the side that looks newer, longer or tidier is not resolving.

## 1. Find out why each side changed it

For every conflicted file, before the first `resolve`:

- **Read the commits.** `sources.pr_side` and `sources.base_side` list the commits on each side that changed this file. Read what each did to it:

  ```bash
  git -C <worktree> show <sha> -- <file>
  ```

- **Read the pull request behind each base commit.** `base_side[].pr` gives its number. The description says what it was for, which the diff does not:

  ```bash
  gh pr view <number> --json title,body
  ```

- **Read the ticket** when a title or body names one, with whatever tracker tool this session has. Skip it when there is none.
- **Read this pull request's own description**, which `start` returned.
- **Read `base_since.renamed`.** A file or name that moved on the base breaks pull-request code that still uses the old one, in files that do not conflict at all.

Read only. No `gh` command that writes, and no git command that changes the worktree.

You are done reading a file when you can say, in one line each, what the pull request wanted there and what the base wanted there. That pair of lines is most of the `why`.

## 2. Choose the kind

| Both sides… | Kind | Example |
|---|---|---|
| added different lines in the same place | `both` | Two new imports; two new cases in a switch; two new entries in a list. Choose `first` so the result reads in the file's own order (alphabetical imports, chronological changelog) |
| changed the same lines, and both changes fit | `combined` | One renamed an argument, the other added one: the line with the new name and the new argument |
| made the same change | `pr` or `base` | Identical but for whitespace, or one side's new lines are all in the other's: free. Otherwise it is asked |
| added two versions of the same code | `combined`, or the fuller side | One branch was built on an earlier copy of the other, so both "added" the same block and one of them then changed it. Writing `both` would repeat the block: it is asked. Find which version is later and what the earlier side has that it lacks |
| want different things | `pr` or `base`, asked | One removed the feature the other extended. The user decides which gives way |

For a `combined` text:

- Start from one side's lines and apply the other side's change to them. Do not write the lines fresh.
- Every name and number either side added must still be there. The harness checks this and asks the user when one is missing.
- Keep the file's indentation and quoting. Do not reformat lines neither side touched.

For whole files:

- **One side deleted it, the other changed it.** Find out why it was deleted. Moved or split: `port`, and carry the change to where the code went. Removed for good: `delete` drops the other side's change, `keep` undoes the deletion. All three are the user's call: git follows a move it can see, so when it reports a deletion, where the code went is your reading of the commits, and you say which commit shows it.
- **A path on one side only, after renames.** Both sides moved the same file to different places. Which place wins is the user's call; the content usually needs to end up in one of them.
- **Binary.** One side's file, whole. Say what each one is (a logo, a fixture, a snapshot) and which commit made it.

## 3. What an edit outside the conflicts may do

Only this: make one side's code fit a change the other side made.

| Allowed | Not allowed |
|---|---|
| A call to a function the other side renamed | Fixing a bug you noticed while reading |
| An import of a file the other side moved | Making a test pass that already failed before the merge |
| A new required argument the other side added to a function | Refactoring, renaming, reformatting |
| A change carried to the file that replaced a deleted one (`port`) | Anything neither side's commits call for |

Each edit names the commit that made it necessary. If you cannot name one, it is not an adaptation.

## 4. Asking the user

One resolution, one question. Give them what they need to answer without opening the file:

```
src/billing/price.ts, line 42

Pull request (a1b2c3d "Add regional pricing"): adds a `region` argument to price().
Base (d4e5f6a "Log prices", pull request #21): renames the argument `n` to `amount`.

I would keep the base's lines. That drops the `region` argument, which the
pull request's callers pass.

Keep the base's lines, keep the pull request's, or write it another way?
```

Say plainly what is dropped. Recommend one option and say why. Then wait.

## 5. Never

- Never resolve a hunk you have not read both sides of.
- Never take one side to avoid a question, or `combined` to avoid one when a name is really gone.
- Never leave a side's change out and call it `both`.
- Never touch a migration to make two of them fit. Say that both sides add one, and name `/real-skills:check-infra-and-migrations`.
- Never say the pull request is mergeable because the push went through. GitHub says that, or nobody does.

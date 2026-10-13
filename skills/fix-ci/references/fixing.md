# Fixing a red check

A check is red because it found something. The job is to remove what it found, with the smallest change that does that, and to leave the check as able to find the next one as it was.

## Read first

For each failure, in this order:

1. **`errors`**: the file, the line and the message. For a test, lint or type failure this is usually the whole story.
2. **`command`**: what the runner ran. It tells you which tool is speaking and how to run it yourself.
3. **`excerpt`**: the lines of the log around the first errors. Read `log` only when these three do not show the cause.
4. **The pull request's diff** against its base, for the files the errors name and what they import. A check that was green on the base and is red here was turned red by something in that diff. Find the line.

Say the cause in one sentence before you edit. If you cannot, you have not found it yet: read more, do not try a change to see what happens.

## What kind of fix

| The check says | The fix is usually |
|---|---|
| A test fails on an assertion | The code the pull request changed. The test describes what the code did before; ask whether the change was meant to alter that |
| A type error | The code: a missing case, a wrong type passed, a signature the pull request changed and a caller it did not |
| A lint or format rule | The code, as the rule asks. Run the tool's own fixer when it has one, and list every file it rewrote |
| A build error | An import, an export or a file the pull request moved or forgot to add |
| A lockfile that does not match its manifest | The package manager's own command, and nothing by hand. It is asked (`dependencies`): say which command wrote it |
| A generated file is out of date | The generator's command. Never edit a generated file by hand |

## When the test is what is wrong

Sometimes the pull request changes behaviour on purpose and the test still describes the old one. Then editing the test is the fix, and it is the user's call, not yours. The harness asks it as `test_edited`. Bring them what they need to answer: what the test expected, what the code now does, and where the pull request (its title, its description, the ticket it names) says the change was intended. If nothing says so, say that.

A snapshot is the same question in another form: updating it means "what the code does now is right".

## Never, without the user's yes

Each of these makes a check pass without fixing what it found. The harness catches them and asks; do not reach for one because it is quick, and do not reshape a fix so that it slips past.

- Skipping, focusing or deleting a test.
- Loosening an assertion until it passes: a wider tolerance, `toBeTruthy` where a value was checked, an expected value copied from the actual one.
- A comment or a cast that silences a rule or a type error.
- Turning a rule off, lowering a threshold, excluding a file in a tool's config.
- Changing the workflow so the step does not run, may fail, or runs something else.
- Adding, removing or pinning a dependency.

## Never at all

- New behaviour. The fix removes the cause of the failure; a feature, a refactor or a cleanup nearby is another pull request.
- A retry loop, a sleep or a longer timeout around a test that fails for a reason you have not found. That is hiding a failure, not fixing one.
- A fix for a failure you could not explain. Say what you found and what you could not, and stop.
- Any edit outside the workspace, and any git write of your own.

## When it is not the code

- **Green here, red in CI** (`not_reproduced`): do not go looking for a fix. Say that the same commit passes on this machine, and offer the rerun. If it is red again after the rerun, the difference between the two machines is the cause: versions, environment variables, the order tests run in, a service CI starts.
- **Red here for another reason** (`differs`): this machine cannot run the job as CI does. Fix from the log if the cause is clear from it, and say the fix was not proven here.
- **The runner's or a secret's** (`infra`, `config`): nothing in the repository fixes it. Report it with the evidence.

## The commit

`subject` is the first line of the commit message: what was fixed, in the repo's own convention when it has one (look at `git log`). Each `why` becomes a line of the body. Write both for someone reading the pull request's history a month from now.

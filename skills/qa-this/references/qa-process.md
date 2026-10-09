# What good QA is here

QA answers one question per item: **does it do what it was meant to, and how do we know?** The second half is the work.

## 1. Criteria first

A criterion is one observable statement: "a member can download a CSV with one row per order", "an empty date range shows an error". Take them from the ticket's acceptance criteria. Where the ticket has none, derive them from the description and the diff, and say in the report that you did.

- Observable means a stranger could check it: a screen shows X, a command exits 0, a table holds N rows, a response is 200.
- "It works", "it is clean", "it feels right" are not criteria. Rewrite them or ask.
- No criteria at all: the item is `not_run`. Ask the user what done means; do not invent a pass.

## 2. Conditions to consider, per criterion

Not every criterion needs every one. Go through the list and keep what could actually fail.

| Condition | Ask |
|---|---|
| Happy path | Does the main case do what the criterion says? |
| Empty and boundary | Nothing selected, zero rows, the first and last allowed value, a very long value |
| Invalid input | Wrong type, missing required field, a value just outside the range |
| Permissions | A user who should not be able to: do they get a clear refusal, and does nothing change? |
| Errors and slow states | What does the screen say when the request fails or takes long? |
| Data | Did the change the user made actually reach storage, once, in the right shape? |
| Regression | The neighbouring flows the diff touched: do they still work? |
| Screen sizes | Only when the change is visual: a phone-width look |

## 3. Depth follows risk

| The change | Depth |
|---|---|
| Money, sign-in, permissions, deletion, a migration | Happy path, every negative case, a data check, the neighbouring flows |
| A new flow or screen | Happy path, empty state, invalid input, one regression look |
| A change to an existing flow | The changed path, and the flow around it |
| Copy, style, a renamed label | One look |

## 4. A check

One action, one expected result, tied to one criterion.

- Good: "Submit the form with an empty date range → an error names the date field."
- Not a check: "Test the form." "Verify export works."
- A check that would pass whether or not the criterion were met covers nothing. Loading the page is not a check of what the page does.
- Pick the method that sees the result directly: a stored value is a database check, not a screenshot of a table; a layout is a browser step, not a unit test.

## 5. Evidence

A pass needs something a stranger could re-check: a command and its exit code, a screenshot of the step, a query and its row count, a request and its status. The harness records these. A sentence saying it passed is not evidence.

## 6. What was not tested

"Not tested" is a result. Every criterion without a check, and every check that did not run, is reported with its reason: no mail sink on staging, sign-in declined, method unavailable. A short honest list is worth more than a status that hides it.

## 7. New tests

Write one only for a criterion no existing test covers, and only where a test can pin the behaviour down.

- Test the behaviour the criterion names, through the same seam the repo's existing tests use.
- Match the file layout, naming and helpers already in the repo.
- Never change source code to make a test pass. A failing new test is a finding.
- They stay uncommitted. The user decides what to keep.

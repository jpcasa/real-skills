# Lens: correctness

Does the changed code do what it is meant to, on every path?

- **Logic:** inverted or off-by-one conditions, wrong operator, wrong variable, a branch that can never run, a case the `switch` or `if` chain forgets.
- **Edge cases:** empty, null or undefined input; zero and negative numbers; the first and last element; very large input; a repeated call.
- **Errors:** a failure that is swallowed, logged and ignored, or turned into a success; a `catch` that hides the cause; a promise nobody awaits; cleanup that does not run on the error path.
- **State and concurrency:** a check followed by a use that something else can change in between; shared state written from two places; retries that repeat a side effect.
- **Callers:** a changed signature, return shape, default or error type that existing callers still use the old way. Search for the callers at the PR head before saying so.
- **Data:** a write that can lose or overwrite data; a query with a missing or wrong condition; a unit or timezone mismatch.
- **Tests in the diff:** an assertion that cannot fail, or a test that no longer checks what its name says.

Report what the diff introduces or exposes. Code that was already wrong and that the PR does not touch is out of scope unless the PR now depends on it.

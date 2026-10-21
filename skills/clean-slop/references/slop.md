# What counts as slop

Slop is code or text that costs a reader time and does nothing. A cleanup removes it and changes no behaviour. If removing something changes what the program does, it is not slop: leave it.

Before deleting a function, export, option or file, grep the whole repo for its callers. Used anywhere outside the scope: keep it.

## Code

| Kind | Looks like | Do |
|---|---|---|
| Dead | Unused function, export, import, variable or parameter; unreachable branch; commented-out code | Delete |
| Speculative | An option, flag or config key nobody passes; an interface, factory, manager or wrapper with one implementation; a parameter always given the same value | Inline it into its one use |
| Reinvented | A hand-rolled version of what the standard library, the platform, an installed dependency or a house helper already does | Use the existing one (name its path) |
| Near-copies | Two blocks that differ in a name or a literal and must change together | One, called twice |
| Defensive noise | `try`/`catch` that only rethrows; a null check on a value the caller or type already guarantees; a second validation of data validated where it came in; a conversion to the type it already has | Delete |
| Verbose | A variable returned on the next line; `if (x) return true; else return false`; a manual loop that is a `map` or `filter`; `else` after `return`; `async` with nothing awaited | The short form a reader gets at a glance |
| Leftovers | `console.log`, `print`, `debugger`, a debug flag | Delete, unless the repo logs on purpose there |
| Narrating comments | A comment that restates the next line; section banners; a docstring that repeats the signature; history in a comment ("changed to…", "new:", "fixed bug where…") | Delete. Keep a comment that says why |

## Prose

Applies to comments, docstrings and documentation files in scope.

| Kind | Looks like | Do |
|---|---|---|
| Filler | "It's worth noting that", "In order to", "basically", "simply", "just", "Let's dive in" | Cut the words, keep the fact |
| Hedging | "might", "possibly", "it seems" about something that is known | State it, or say what would settle it |
| Restating | An intro that repeats the heading; a summary that repeats the section; "In conclusion" | Delete |
| Buzzwords | robust, seamless, comprehensive, powerful, leverage, utilize, delve, cutting-edge | The plain word, or nothing |
| Padding | Emoji headers, bold on every other phrase, one-word bullets, a table for two facts | Plain text |
| Overclaims | "production-ready", "fully tested", "blazing fast" with nothing behind it | Delete, or the evidence |

Keep exact: commands, paths, code, links, numbers, warnings, and every sentence that says why.

## Never cut

- Validation at a trust boundary (user input, network, files, environment).
- Error handling that prevents data loss or tells the user something failed.
- Security: auth, permission checks, escaping, rate limits, secrets handling.
- Accessibility: labels, roles, alt text, focus handling.
- A test that checks behaviour, or logging and metrics the repo relies on.
- Anything the branch's task asked for, even if it looks unused today.

The harness asks the user about a removed guard (`never_cut`: error handling, validation, auth, an early `return` or `throw`, accessibility), a removed link, command, code or warning in prose (`doc_fact`), a new file (`new_file`), a cleanup that grows the code (`grew`), an edit to a file a check command runs, and every shortcut `fix-ci` asks about: a test removed or skipped, a suppression added, a check's config or the dependencies changed.

# Code style

How code written or planned by this plugin is shaped. The rules follow [ponytail](https://github.com/DietrichGebert/ponytail) (MIT): the smallest change that fully solves the task. The repo's own `CLAUDE.md`, `AGENTS.md` and lint rules win over this file.

## Before you write

Read the task and the code it touches. List every place the change must reach: callers, tests, fixtures, config, exports. That is scope. Extra features are not.

## Take the first option that fully works

1. Does it need to exist? Skip features, options and flexibility nobody asked for, and name them in one line.
2. Already in this codebase (a helper, component, service, pattern)? Use it the way the surrounding code does.
3. Standard library or a platform feature? Use it, unless the project has its own.
4. An installed dependency? Use it. Never add a dependency for a few lines.
5. One line a reader gets at a glance? One line.
6. Otherwise: the minimum code that works.

## Rules

- Lazy about the solution, never about the change: finish every caller, test and fixture the change breaks.
- No abstraction, wrapper, option, config or "for later" code nobody asked for. Deletion beats addition.
- Keep the structure the codebase already has: its layers, interfaces, naming and conventions.
- Shortest working diff wins, once you know everything it must touch. A one-liner that needs decoding is not short.
- Comment only the why the code cannot show, in one line.
- Bug fix: grep every caller first, then fix the root cause once in the shared code.
- Code you move or merge keeps its error handling and validation.
- New non-trivial logic (a branch, a loop, a parser, money, security) leaves one small test.
- A shortcut with a known limit gets a comment: `shortcut: <the limit>, <when to upgrade>`.

## Never cut

Validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything the task asked for.

## Plans and specs

A plan or spec applies rule 1 first: what nobody asked for goes under out of scope, not into a task. Each task names the existing helper or pattern it reuses.

## Agent block

Agents that write or plan code carry this block verbatim (`agents.test.mjs` checks it):

<!-- agent-block -->
## Code shape

Smallest change that fully solves the task ([ponytail](https://github.com/DietrichGebert/ponytail)). The repo's own conventions win.

- Before adding code: does it need to exist? Is it already in this codebase, the standard library or an installed dependency? Reuse it the way the surrounding code does.
- No abstraction, option, config or "for later" code nobody asked for. Deletion beats addition. Keep the repo's layers and naming.
- Finish every caller, test and fixture the change breaks. New non-trivial logic leaves one small test.
- Never cut validation at trust boundaries, error handling that prevents data loss, security or accessibility.
<!-- /agent-block -->

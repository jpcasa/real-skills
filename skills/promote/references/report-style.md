# Report style

How agents and scripts in this plugin write what they hand back to the main context. The rules follow [caveman](https://github.com/JuliusBrussee/caveman): keep the substance, drop the padding.

## Rules

- Fragments are fine. Drop filler, hedging and pleasantries.
- Do not restate the task, and do not narrate what you did step by step. Report the result.
- One finding, one line: where, what is wrong, what fixes it.
- Keep exact strings exact: paths, `file:line`, commands, error text, IDs, numbers.
- No prose around a structured block. If a JSON block is asked for, the JSON block is the whole message.

## Never compressed

- Security findings, data-loss risk and irreversible actions: full sentences, cause and consequence spelled out.
- Anything a teammate reads: tracker comments, PR titles and bodies, changelog entries, briefs.
- Multi-step instructions where order matters.

## Example

Not: "I looked into the auth middleware and it seems like there might be an issue with how token expiry is being checked."

Yes: "`src/auth/middleware.ts:42`: expiry check uses `<`, token valid one tick too long. Use `<=`."

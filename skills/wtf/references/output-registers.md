# Output registers

`wtf` writes the same investigation in one of two voices. Pick with `--tech` or `--plain`; ask if neither was given, the config has no `default_register`, and the phrasing does not settle it.

The investigation never changes. Only the last step does. Both registers use the verdict, confidence and `raise_with` the harness returned, as returned.

---

## `--tech` — for engineers

Terse, in the style of [report-style.md](report-style.md). `file:line` first, no preamble, no restating the report.

```md
**<VERDICT>** — <one line: what is actually happening>

## Prior art
- <ticket id> "<title>" — <open|closed> — <how it relates>   (or: none found, N queries)
- PR #<n> <state> — <what it changes> — <skew detail: "on main, not yet in production">
- <memory or notes entry> — <what it recorded>

## Evidence
`path/to/file.ts:123` — <what this line does, and why that produces what they saw>.
`path/to/other.tsx:45` — <contributing surface>.
(Citations are verified to exist. Unverified ones are listed separately, marked as such, or left out.)

## Runtime   (only if looked up)
<source> — <exact error string, or "no error in the window">. Corroborates; does not decide.

## Reproduction   (only if run)
<environment> — <reproduced | not reproduced | blocked> — <the step that failed and what was seen>

## Trigger
<the exact condition. Role, state, sequence.>

## Blast radius
<who hits it, how often, which tenants or flows. "One tenant, one screen" and "every user on every
route" are very different findings. Say which.>

## Confidence
<high|medium|low> — raise it with: <raise_with from the harness>

## Next
<the next command or action · nothing, answered by <ticket> · ask <person> for <fact>>
Run: <run id> — `/real-skills:wtf outcome <run id> right|wrong` once you know.
```

For a `DEFECT` with no existing ticket, add a draft the reader can file. `wtf` never files it:

```md
## Ticket draft
**Title:** <what is broken, where>
**Steps:** 1. … 2. …
**Expected:** …
**Actual:** …
**Evidence:** `file:line` …
**Blast radius:** …
```

Rules:

- Exact error strings, paths, line numbers, IDs and procedure names, verbatim.
- Code blocks unchanged. Never paraphrase an error message.
- No praise, no hedging, no "it seems like". If uncertain, say what would settle it.
- Security findings and anything irreversible are written in full sentences. Brevity that hides a risk is a defect.

---

## `--plain` — for support, ops, clients

The reader is not an engineer and may be the person who filed the report. They need to know whether they did something wrong, what to do instead, and whether anyone is fixing it.

```md
**<Short plain headline: what happened>**

<2–3 sentences. What the system did and why. No file paths, no function names, no jargon.>

**Has this come up before?**
<Yes: it was reported on <date> and <what was decided>. / No, this looks like the first report.>

**What to do**
1. <Real on-screen label, taken from the source: "Cancel order", not "the cancel action">
2. <…>
3. <…>

**Why the other way didn't work**
<One sentence. People repeat what they don't understand.>

**Where this stands**
<Nothing is broken: this is how the screen works. / This is a real bug; it has been passed to the
engineering team. / A fix is already built and goes out with the next release.>
```

Rules:

- **On-screen labels come from the source**, not from memory and not from the reporter's paraphrase. A wrong label sends people to the wrong screen.
- No `file:line`, no table names, no procedure names, no PR numbers, no run id. If the reader would have to ask what a word means, cut it.
- Never say "working as intended" as the whole answer. Say what to do instead.
- Numbered steps stay a numbered list. Never compress a procedure into a paragraph.
- For `DEFECT`, do not imply a timeline. "Passed to engineering" is true; "fixed next week" is not yours to promise.
- For `INSUFFICIENT_INFO`, ask for exactly one thing, in their vocabulary: a screenshot of a named screen, the order number, the time it happened.
- This register is never compressed.

After a `--plain` report, give the person who ran the skill (not the reader of the report) one separate line: the run id and the `outcome` command.

---

## Both registers

End with confidence and the next step. In `--plain` those are "Where this stands" and the action line. A report with no stated confidence reads as certain, and an honest `INSUFFICIENT_INFO` is a better product than a confident guess that gets forwarded to a client.

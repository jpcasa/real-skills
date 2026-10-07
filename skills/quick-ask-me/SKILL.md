---
name: quick-ask-me
description: Lightweight interview for quick tasks. Asks the objective, then the success criteria, then only the questions needed to make the plan solid enough to implement. Writes glossary terms to CONTEXT.md and rare ADRs as it goes, and ends with a short brief. User-invoked only.
disable-model-invocation: true
---

# Quick Ask Me

A quick-task variant of a full grilling interview such as Matt Pocock's `/grill-with-docs`. Same engine (a one-question-at-a-time interview), same deliverable (`CONTEXT.md` glossary entries and rare ADRs), but with a hard question budget and two mandatory openers. The goal is shared understanding plus a short brief an implementation step can run from — not a full spec.

Do not act on anything until the user confirms we have reached a shared understanding. Never start implementing from inside this skill.

`S` below is this skill's directory: `${CLAUDE_PLUGIN_ROOT}/skills/quick-ask-me` in Claude Code, or wherever your agent installed the skill (e.g. `~/.codex/skills/quick-ask-me`).

## The gate script

`node "$S/scripts/gate.mjs" <questions|criteria|stop>` reads JSON on stdin and prints one JSON object. It holds the budget and the stop conditions in code, and asks [Jev](https://typesafe.ai) for the judgments when a TypeSafe key is present. You draft; it decides what reaches the user.

- Each result has a `mode`. `degraded` or `off` means Jev did not answer: the script then applies the budget and the presence checks only, and the judgments are yours, exactly as the rules below describe them.
- A `null` verdict means "not decided here": judge it yourself. The `jev` numbers in a result are a log for calibration, not an instruction.
- If Node is missing or the script errors, carry on without it and follow the rules below by hand.
- With a key set, it sends the objective, the criteria, the facts you looked up and your candidate questions to api.typesafe.ai, after redacting credential-shaped strings. It never sends file contents. `QUICK_ASK_ME_JEV=off` sends nothing.

## Opening questions — always, in this order, one at a time

### Q1 — Objective

Ask: "What's the main goal?"

If the user already passed the goal as the skill argument or in the surrounding conversation, restate it in one sentence and ask them to confirm or correct it. That is still one question — wait for the answer.

### Q2 — Success criteria

Ask: "How will we know it's done?"

Every criterion must be observable: a test passes, a command prints X, a user can do Y, a metric moves from A to B. Reject "it works", "it's clean", "it feels right" — push once for something checkable. Offer a recommended set of two to four criteria based on the objective and what you can see in the codebase.

Check the answer with the script, and push once on any criterion it marks `observable: false` (on `null`, use your own judgment):

```bash
printf '%s' '{"objective":"…","criteria":["…","…"]}' | node "$S/scripts/gate.mjs" criteria
```

## Grill rules

- After Q2, draft every question you think is still open, each with your recommended answer, and pass the list through the gate before asking any of them:

  ```bash
  printf '%s' '{"objective":"…","criteria":["…"],"facts":["…"],"asked":0,"candidates":[{"id":"q1","text":"…","recommended":"…"}]}' \
    | node "$S/scripts/gate.mjs" questions
  ```

  It returns `{ask, lookup, skip, over_budget}`. **Ask** only the ids in `ask`, in that order. **Look up** the ids in `lookup` in the repo and state what you found. **Skip** the ids in `skip`: take your recommended answer and list it in the brief under "Assumed without asking". Leave `over_budget` for the "keep going?" question. When an answer opens a new question, run the gate again with the new candidates and the updated `asked` count.
- Ask one question at a time. Wait for the answer before asking the next. Asking multiple questions at once is bewildering.
- Keep each question to two sentences at most, plus the recommended answer. A looked-up fact is one line. See [references/report-style.md](./references/report-style.md); the closing brief is exempt and stays in full sentences.
- Every question ships with your recommended answer.
- If a *fact* can be found by exploring the environment (filesystem, git, tools), look it up rather than asking. *Decisions* are the user's — put each one to them and wait.
- State facts you looked up alongside the question they inform ("the repo has no export script yet, so…"). Stating a fact is not a question and does not count against the budget.
- Walk dependencies in order: resolve the decision that other decisions hang on before asking about the ones that hang on it.

## Lightweight rules — what makes this not a full grill

- **Question budget: at most 6 questions after the two openers.** When the budget is spent, summarise where things stand and ask exactly one more question: "Good enough to implement, or keep going?" Continue only if the user says so.
- **Only ask what would change what gets built.** Skip the full decision-tree walk. If the answer wouldn't alter the code, the tests, or the scope, don't ask it.
- **Stop early** — before the budget is spent — when all five are true. Check after each answer with `node "$S/scripts/gate.mjs" stop` (input `{objective, objective_confirmed, criteria, criteria_observable, out_of_scope, seam, term_conflicts, asked}`); it returns `{stop, missing, budget_left, budget_spent}`. Ask about what is in `missing` next, and move to the closing brief when `stop` is true:
  1. the objective is confirmed
  2. every success criterion is observable
  3. the scope boundary is named (what is explicitly *not* being done)
  4. the seam is known — where the tests will live and what interface they exercise
  5. there are no unresolved term conflicts with `CONTEXT.md`

## Docs as you go

This is the domain-modeling discipline (Matt Pocock's `domain-modeling` skill), slimmed. If the `domain-modeling` skill is available in this host, use its format files instead of the copies in `references/` — same content, avoids drift.

- **Challenge terms.** When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately. When they use a vague or overloaded term, propose a precise canonical one.
- **Write resolved terms to `CONTEXT.md` inline, the moment they resolve.** Don't batch them for the end. Format is in [references/CONTEXT-FORMAT.md](./references/CONTEXT-FORMAT.md). Create the file lazily — only when the first term resolves. If a `CONTEXT-MAP.md` exists, write to the relevant context's `CONTEXT.md` instead of the root.
- **Glossary only.** `CONTEXT.md` holds vocabulary and nothing else — no implementation details, no spec, no scratch notes.
- **ADRs only when all three hold:** hard to reverse, surprising without context, and the result of a real trade-off. Format is in [references/ADR-FORMAT.md](./references/ADR-FORMAT.md). Create `docs/adr/` lazily. Expect zero ADRs on most quick tasks — that is the intended shape, not a failure.

## Closing brief

When shared understanding is confirmed, print this in chat and stop:

```md
## Brief: <title>

**Objective:** <one sentence>

**Success criteria:**
- [ ] <observable criterion>
- [ ] <observable criterion>

**Decisions:**
- <decision> (see docs/adr/000N-<slug>.md, if one was written)

**Out of scope:** <what is explicitly not being done>

**Assumed without asking:** <question the gate skipped → the recommended answer taken; "none" if the gate skipped nothing>

**Seam / where tests live:** <interface the tests exercise, and the test location>

**Docs written:** CONTEXT.md (terms: <list>), docs/adr/000N-<slug>.md (if any)

Next: implement (e.g. `/implement`, if installed)
```

Then ask exactly one question: "Save this brief to `docs/briefs/<slug>.md`?" Recommend **no** for quick tasks — the brief lives in the conversation and the implementation step reads it from there. Write the file only if the user says yes.

Do not start implementing yourself. Hand off and stop.

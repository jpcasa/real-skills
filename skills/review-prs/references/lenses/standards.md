# Lens: standards

Two axes. Cite the rule for every standards finding.

**Written rules.** Read the repository's own rules at the PR base (the prompt lists the files and how to read them): its agent and contributor guides, lint and formatter config, and the conventions of the code next to the change. Only written rules, or patterns the surrounding code follows without exception, count. Look for naming, layering, error handling, file and test placement, and APIs the rules forbid.

**What the PR says it does.** Compare the diff with the PR title, body and linked ticket.

- Something the description promises that the diff does not do, or does only partly.
- A change the description never mentions (scope creep).
- Behaviour that changes for existing users with no mention of it.
- New behaviour with no test, where the repository tests that kind of code.

A preference of yours that no rule states is not a finding. Formatting the repository's formatter would fix is not a finding.

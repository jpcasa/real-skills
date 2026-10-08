# Lens: accessibility

Static review of the changed UI files against WCAG 2.2 AA. Cite the success criterion in each finding.

- **Semantics and roles:** real `button`, `a` and `input` elements, not clickable `div`s; the repository's accessible primitives used as documented (4.1.2).
- **Names and labels:** every control has an accessible name; icon-only buttons have one; images have alt text or are marked decorative; fields have labels and their errors are tied to them (1.1.1, 1.3.1, 3.3.1, 3.3.2).
- **Keyboard:** everything operable by keyboard, no traps, Escape closes overlays, focus returns to the trigger (2.1.1, 2.1.2).
- **Focus:** logical order, a visible indicator (no bare `outline: none`), focus moved into new dialogs, not hidden behind sticky UI (2.4.3, 2.4.7, 2.4.11).
- **Contrast:** compute ratios from the actual token values, never guess: 4.5:1 for text, 3:1 for large text and component boundaries (1.4.3, 1.4.11).
- **Target size:** at least 24 by 24 CSS px, or enough spacing (2.5.8).
- **Other:** status messages announced (4.1.3), colour not the only signal (1.4.1), `prefers-reduced-motion` respected, heading order.

`bug` for a failure that stops a task (keyboard trap, unlabeled control, body-text contrast failure); otherwise `risk` or `nit`. You have no browser: say what you could not check.

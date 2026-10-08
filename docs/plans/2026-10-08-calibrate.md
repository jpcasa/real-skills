# calibrate Plan

Spec: docs/specs/2026-10-08-calibrate.md
Goal: every uncalibrated Jev question logs comparable cases, gets labels, and can be switched on locally by `/real-skills:calibrate` once it meets the bar.
Verify: `node --test skills/*/scripts/test/*.test.mjs && bash skills/changelog/scripts/test/release-ranges.test.sh && claude plugin validate . --strict`
Constraints:
- Node 20+, zero npm dependencies, ES modules, one JSON object on stdout per CLI call.
- Each skill folder stays self-contained: `lib/calibration.mjs` is an identical copy in six folders (five skills + `calibrate`), pinned by `sync.test.mjs`.
- `calibrate` makes no network call and imports nothing from another skill: every case record carries its own threshold, direction and unsafe side.
- With no `calibration.json`, every skill behaves exactly as it does at 0.3.0.
- `merge_approval`, `qa_approval`, code vetoes and `wtf`'s verdict rules are unreachable from the file.
- `show` text is redacted through the skill's own redaction; if redaction is unavailable, `show` is dropped.

## File map

- `skills/calibrate/scripts/lib/calibration.mjs` (source of the copies): file reader, `isOn`, `threshold`, `spotCheck`, `writeCases`, `writeLabel` (with auto-revoke), `revoke`.
- `skills/calibrate/scripts/lib/bar.mjs`: `evaluate(cases)` → status, proposed threshold, counts, bound.
- `skills/calibrate/scripts/calibrate.mjs`: `status | label-next | label | apply | revoke`.
- `skills/calibrate/SKILL.md`, `agents/openai.yaml`, `scripts/test/calibrate.test.mjs`.
- `skills/{do-shit,changelog,quick-ask-me,ask-and-create-specs,wtf}/scripts/lib/calibration.mjs`: copies.
- `do-shit`: `lib/questions.mjs` (`isCalibrated`, `thresholdOf`), `lib/autonomy.mjs` (spot check, case), `harness.mjs` + `lib/merge.mjs` (case at the gate, label at the answer).
- `changelog/scripts/judge.mjs`, `quick-ask-me/scripts/gate.mjs` (+ `answered`), `ask-and-create-specs/scripts/spec-jev.mjs`, `wtf/scripts/wtf.mjs` + `lib/questions.mjs`: cases, reader, labels where natural.
- `skills/do-shit/scripts/test/sync.test.mjs`, `README.md`, manifests (`0.4.0`).

## Tasks

### Task 1: Shared library and the bar
Files: calibrate/scripts/lib/{calibration,bar}.mjs, calibrate/scripts/test/calibrate.test.mjs
Produces:
```
C.dir()                               REAL_SKILLS_CALIBRATION_DIR || ~/.claude/state/calibration
C.entry(skill, q) / C.isOn / C.threshold(skill, q, builtin)
C.spotCheck(caseId)                   deterministic, one in ten
C.writeCases(file, cases, redactBody) one batch redaction; adds v, type:'case', ts
C.writeLabel(file, {case, skill, question, label, source, p?, acts_when?, unsafe?})  -> {revoked}
C.revoke(skill, q, reason)
evaluate(cases[{p,label,acts_when,unsafe,threshold}]) -> {status, n, labeled, split, proposed, unsafe_errors, act_rate, bound, near[]}
```
Case record: `{v:1,type:'case',skill,question,case,p,threshold,acts_when:'gte'|'lt'|'both',unsafe:'fp'|'fn'|null,fallback,acted,spot,show,ts}`.
Parallel: no
- [ ] Failing tests: 29 labeled fails; 4 of one label fails; unsafe error at every threshold → `no safe threshold`; safety step applied in the right direction for `fp` and `fn`; `unsafe:null` picks best accuracy; act rate under 0.1 → `never acts`; off switch and malformed file read as empty; spot check stable and near 10%; unsafe label on a live case revokes.
- [ ] Implement. Run calibrate tests → pass. Commit.

### Task 2: calibrate CLI and skill
Files: calibrate/scripts/calibrate.mjs, SKILL.md, agents/openai.yaml, tests
Parallel: no
- [ ] Failing tests: `status` reads cases and labels from all five state dirs, last record per case wins; `label-next` orders by distance to threshold, skips labeled, caps at 12; `label` ignores `cant_tell`; `apply` recomputes and refuses anything not `ready`; `revoke`; doc-pin.
- [ ] Implement. Commit.

### Task 3: Wire the five skills
Files: as in the file map
Parallel: no (one shared test pattern)
- [ ] Failing tests per skill: a case record per question with the right `acts_when`/`unsafe`; the local file turns a question on only in `live`; `REAL_SKILLS_CALIBRATION=off` ignores it; spot-checked case does not act; natural labels (do-shit gate answers, wtf outcome mapping, quick-ask-me `answered`); nothing changes with no file.
- [ ] do-shit test: no entry in the file can make `merge_approval` or `qa_approval` auto.
- [ ] Implement. Run all → pass. Commit per skill.

### Task 4: Plugin wiring
- [ ] Sync test covers the six `calibration.mjs` copies. README section, table rows, layout. Version `0.4.0`. Full Verify. Commit.

### Task 5: Real pass and review
- [ ] `status` against this machine's logs: 23 questions, none ready.
- [ ] `cavecrew-reviewer` on the branch diff; fix confirmed findings; rerun Verify.

## Self-check

1. Spec A → T1+T3; B → T1 (writeLabel), T2 (label), T3 (natural); C → T1; D → T2+T3; E → T1+T3.
2. Deviations, deliberate:
   - Natural labels are written by the skill that has them, into its own log, not into `calibration/labels.jsonl`. `calibrate` reads `type:"label"` from every log. Keeps `calibrate` free of per-skill knowledge.
   - `unsafe` may be `null`: several questions only add strictness when they act (`wtf`'s three, `scope_boundary_named`, `seam_is_known`), so no error removes a human check. Those are chosen on accuracy.
   - `do-shit` logs a case only when no veto fired: a vetoed gate skips the Jev call today.
   - `ask-and-create-specs` shares thresholds across questions (`gate` covers four). The threshold is the unit calibrated.

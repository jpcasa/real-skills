// Verdict rules. The model proposes a verdict; this decides whether the
// evidence supports it. A verdict that is not supported becomes
// INSUFFICIENT_INFO, with what is missing. Every input here has already been
// checked by code where code can check it: citations carry `verified`, `fix`
// is a skew() result, `repro` comes from run state.

export const VERDICTS = ['USER_ERROR', 'DEFECT', 'FEATURE_REQUEST', 'ALREADY_FIXED', 'KNOWN', 'INSUFFICIENT_INFO'];
// Counter-priors: observations that are never the user's mistake.
export const COUNTER_FLAGS = ['enabled_noop', 'wrong_data_shown', 'silent_write_noop', 'worked_before_unchanged_flow'];

const has = (evidence, ...roles) => evidence.some((e) => e.verified && roles.includes(e.role));
const list = (v) => (Array.isArray(v) ? v.filter((s) => String(s ?? '').trim()) : []);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

// One verdict's requirements. scope 'messaging' is the DEFECT half of a split.
function check(verdict, i, scope = null) {
  const missing = [];
  const vetoes = [];
  const counter = i.flags.filter((f) => COUNTER_FLAGS.includes(f));
  const reproduced = i.repro?.result === 'reproduced';

  switch (verdict) {
    case 'KNOWN':
      if (!i.prior.some((p) => p.id && p.url && p.same_issue === true)) missing.push('a prior ticket with id and url, marked as the same issue');
      break;
    case 'ALREADY_FIXED':
      if (!i.fix?.exists) missing.push(`a fix commit or PR that exists${i.fix?.detail ? ` (${i.fix.detail})` : ''}`);
      else if (i.fix.in_env) vetoes.push(`the fix is already in the environment the report came from (${i.fix.detail}): if it still happens, it is a DEFECT`);
      break;
    case 'USER_ERROR':
      if (!has(i.evidence, 'guard', 'designed_behavior')) missing.push('a verified citation with role guard or designed_behavior');
      if (!list(i.steps).length) missing.push('at least one step for what to do instead');
      for (const f of counter) vetoes.push(`${f}: never user error`);
      if (reproduced && i.repro_followed_correct_steps === true) vetoes.push('the reproduction followed the right steps and still failed');
      break;
    case 'DEFECT':
      if (scope === 'messaging') {
        if (!has(i.evidence, 'message') && !text(i.message_absent)) missing.push('a verified citation with role message, or message_absent saying what was looked for');
        break;
      }
      if (!(has(i.evidence, 'expected') && has(i.evidence, 'actual')) &&
        !(reproduced && (i.repro.failed_steps || 0) > 0) &&
        !(counter.length && has(i.evidence, 'handler', 'write_path', 'actual'))) {
        missing.push('verified citations for expected and actual, or a reproduction with a failed step, or a counter-prior flag with a verified handler/write_path/actual citation');
      }
      break;
    case 'FEATURE_REQUEST':
      if (i.premise_exists !== false) missing.push('premise_exists: false');
      if (!list(i.searched).length) missing.push('what was searched to conclude the behaviour does not exist');
      if (has(i.evidence, 'exists')) vetoes.push('a verified citation shows the behaviour exists');
      break;
    case 'INSUFFICIENT_INFO':
      if (!text(i.missing_fact)) missing.push('the one missing fact');
      if (!text(i.who)) missing.push('who can supply it');
      break;
    default:
      missing.push(`unknown verdict ${verdict}`);
  }
  // Calibrated Jev answers can only take support away (see wtf.mjs), never add it.
  if (scope !== 'messaging') for (const m of i.extra_vetoes?.[verdict] || []) vetoes.push(m);
  return { verdict, scope, ok: !missing.length && !vetoes.length, missing, vetoes };
}

// Computed, never asserted. Runtime evidence can corroborate; it cannot carry a verdict.
function confidence(verdicts, i) {
  const verified = i.evidence.filter((e) => e.verified).length;
  const second = [
    i.prior.some((p) => p.same_issue === true) && 'prior art',
    i.repro?.result === 'reproduced' && 'reproduction',
    i.runtime.some((r) => r.kind === 'error' && r.matches_code === true) && 'a runtime error that matches the code',
  ].filter(Boolean);
  const v = verdicts[0].verdict;
  if (v === 'INSUFFICIENT_INFO') return { level: 'low', raise_with: text(i.missing_fact) || 'the missing evidence listed above' };
  if (v === 'ALREADY_FIXED') return { level: 'high', raise_with: 'nothing: the commit history settles it' };
  if (v === 'KNOWN') {
    return verified
      ? { level: 'high', raise_with: 'nothing more needed' }
      : { level: 'medium', raise_with: 'a verified citation showing it is the same code path as the prior ticket' };
  }
  if (verified && second.length) return { level: 'high', raise_with: 'nothing more needed' };
  if (verified) {
    return { level: 'medium', raise_with: i.repro ? 'prior art or a matching runtime error' : 'a reproduction, prior art, or a matching runtime error' };
  }
  return { level: 'low', raise_with: 'a verified citation of the code path' };
}

export function decide(raw) {
  const i = {
    ...raw,
    proposed: list(raw.proposed),
    prior: Array.isArray(raw.prior) ? raw.prior : [],
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    flags: list(raw.flags),
    runtime: Array.isArray(raw.runtime) ? raw.runtime : [],
    repro: raw.repro || null,
  };
  const unknownFlags = i.flags.filter((f) => !COUNTER_FLAGS.includes(f));
  const supported = VERDICTS.filter((v) => v !== 'INSUFFICIENT_INFO' && check(v, i).ok);

  let checks;
  let error = null;
  if (!i.proposed.length) error = 'no verdict proposed';
  else if (i.proposed.some((v) => !VERDICTS.includes(v))) error = `unknown verdict: ${i.proposed.filter((v) => !VERDICTS.includes(v)).join(', ')}`;
  else if (i.proposed.length === 2) {
    // The one built-in split: the logic was right, the screen did not say so.
    if ([...i.proposed].sort().join('+') !== 'DEFECT+USER_ERROR') error = 'the only split verdict is USER_ERROR (logic) + DEFECT (messaging)';
    else checks = [check('USER_ERROR', i, 'logic'), check('DEFECT', i, 'messaging')];
  } else if (i.proposed.length > 2) error = 'at most two verdicts';
  else checks = [check(i.proposed[0], i)];

  const base = { proposed: i.proposed, supported, ...(unknownFlags.length ? { unknown_flags: unknownFlags } : {}) };
  if (error) {
    const verdicts = [{ verdict: 'INSUFFICIENT_INFO', scope: null }];
    return { ...base, accepted: false, verdicts, downgraded_from: i.proposed, missing: [error], vetoes: [], confidence: 'low', raise_with: 'a valid proposed verdict' };
  }
  const missing = checks.flatMap((c) => c.missing.map((m) => `${c.verdict}${c.scope ? ` (${c.scope})` : ''}: ${m}`));
  const vetoes = checks.flatMap((c) => c.vetoes.map((m) => `${c.verdict}: ${m}`));
  const accepted = checks.every((c) => c.ok);
  const verdicts = accepted ? checks.map((c) => ({ verdict: c.verdict, scope: c.scope })) : [{ verdict: 'INSUFFICIENT_INFO', scope: null }];
  const conf = confidence(verdicts, i);
  return {
    ...base, accepted, verdicts,
    ...(accepted ? {} : { downgraded_from: i.proposed }),
    missing, vetoes, confidence: conf.level, raise_with: accepted ? conf.raise_with : (missing[0] || vetoes[0]),
  };
}

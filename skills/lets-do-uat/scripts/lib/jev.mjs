// Jev (TypeSafe System One) client for the /do-shit harness.
//
// Contract checked against https://docs.typesafe.ai/api.md on 2026-09-28:
//   POST https://api.typesafe.ai/v1/systemone   Authorization: Bearer <key>
//   body  { state, model: "jev-latest", questions: { id: Question } }
//   noul   -> { type:"noul",   noul: 0..1 }
//   choice -> { type:"choice", choice, probabilities:{opt:p}, confidence }
//   score  -> { type:"score",  score: 0..levels-1, legend, probabilities, confidence }
//   errors: 401 bad key, 422 validation, 429 rate limit, 529 overloaded
//
// Every request body is redacted through hooks/lib/redact.jq (shared with
// guard-jev.sh) before it leaves the machine. Any failure returns
// { degraded: true } so the harness can apply its conservative fallback.

import { execFileSync } from 'node:child_process';
import { REDACT_LIB } from './paths.mjs';

const API_URL = process.env.TYPESAFE_API_URL || 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const TIMEOUT_MS = 8000;

export function resolveKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'typesafe-api', '-w'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

export function redactBody(body) {
  const out = execFileSync('jq', ['-c', '-L', REDACT_LIB, 'include "redact"; redact_strings'], {
    input: JSON.stringify(body),
  });
  return JSON.parse(out.toString());
}

async function httpTransport(body, key) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let json = {};
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

let transport = httpTransport;
export const setTransport = (fn) => (transport = fn);
export const resetTransport = () => (transport = httpTransport);

const retryable = (status) => status === 0 || status === 429 || status >= 500;

function checkAnswers(questions, answers) {
  for (const [id, q] of Object.entries(questions)) {
    const a = answers?.[id];
    if (!a || a.type !== q.type) return `missing answer for ${id}`;
    if (q.type === 'noul' && typeof a.noul !== 'number') return `bad noul for ${id}`;
    if (q.type === 'choice' && typeof a.choice !== 'string') return `bad choice for ${id}`;
    if (q.type === 'score' && typeof a.score !== 'number') return `bad score for ${id}`;
  }
  return null;
}

// ask({ state, questions, key?, retryDelayMs? }) -> { answers, degraded, error?, model?, usage? }
export async function ask({ state, questions, key = resolveKey(), retryDelayMs = 1000 }) {
  if (!key) return { answers: {}, degraded: true, error: 'no TypeSafe API key' };

  let body;
  try {
    body = redactBody({ state, model: MODEL, questions });
  } catch (e) {
    // Never send unredacted content.
    return { answers: {}, degraded: true, error: `redaction failed: ${e.message}` };
  }

  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await transport(body, key);
    } catch (e) {
      res = { status: 0, json: {}, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
    }
    if (res.status === 200) {
      const err = checkAnswers(questions, res.json.answers);
      if (err) return { answers: res.json.answers || {}, degraded: true, error: err };
      return { answers: res.json.answers, degraded: false, model: res.json.model, usage: res.json.usage };
    }
    last = `HTTP ${res.status}${res.error ? ` (${res.error})` : ''}`;
    if (!retryable(res.status) || attempt === 1) break;
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  return { answers: {}, degraded: true, error: last };
}

// What happened under the hood during a step: the requests the page made and
// the console errors it logged, as the agent read them from the browser tools.
// Kept as derived facts only: method, path template, status, time. Never a
// query string, a body, a header or a full console text.

import { scrub } from './scrub.mjs';

const STATIC = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm)$/i;
export const MAX_REQUESTS = 60;
export const MAX_ERRORS = 10;

// /api/orders/8f14e45f-…/items/42 -> /api/orders/:id/items/:id
export const template = (path) =>
  String(path)
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) || /^[A-Za-z0-9_-]{24,}$/.test(seg) ? ':id' : seg))
    .join('/');

function where(url, appHost) {
  try {
    const u = new URL(url);
    return { host: u.hostname === appHost ? '' : u.hostname, path: template(u.pathname) };
  } catch {
    return null;
  }
}

// requests: [{method, url, status, ms?}], console: [{level, text}] -> clean lists.
export function cleanSignals({ requests = [], console: logs = [] } = {}, appHost) {
  const reqs = [];
  for (const r of Array.isArray(requests) ? requests : []) {
    const w = where(r?.url, appHost);
    // The capture receiver's own POST is this skill's, not the app's.
    if (!w || STATIC.test(w.path) || (w.host === '127.0.0.1' && w.path === '/shot')) continue;
    const status = Number.isFinite(Number(r.status)) ? Number(r.status) : 0;
    reqs.push({ method: String(r.method || 'GET').toUpperCase().slice(0, 7), endpoint: `${w.host}${w.path}`.slice(0, 160), status, ...(Number.isFinite(Number(r.ms)) ? { ms: Math.round(Number(r.ms)) } : {}) });
    if (reqs.length >= MAX_REQUESTS) break;
  }
  const errors = (Array.isArray(logs) ? logs : [])
    .filter((l) => /^(error|exception)$/i.test(String(l?.level || '')))
    .slice(0, MAX_ERRORS)
    .map((l) => scrub(String(l.text || '').replace(/https?:\/\/\S+/g, (u) => u.split(/[?#]/)[0])).replace(/\s+/g, ' ').slice(0, 160));
  return { requests: reqs, errors };
}

// The facts for one flow, from every step's signals: what the summary is written from.
export function flowFacts(steps) {
  const reqs = steps.flatMap((s) => s.record?.signals?.requests || []);
  const errors = steps.flatMap((s) => (s.record?.signals?.errors || []).map((e) => `step ${s.n}: ${e}`));
  const by = new Map();
  for (const r of reqs) {
    const k = `${r.method} ${r.endpoint}`;
    const e = by.get(k) || { endpoint: k, count: 0, statuses: [] };
    e.count++;
    if (!e.statuses.includes(r.status)) e.statuses.push(r.status);
    by.set(k, e);
  }
  const timed = reqs.filter((r) => typeof r.ms === 'number').sort((a, b) => b.ms - a.ms);
  return {
    requests: reqs.length,
    endpoints: [...by.values()].sort((a, b) => b.count - a.count).slice(0, 10),
    failed: [...by.values()].filter((e) => e.statuses.some((s) => s === 0 || s >= 400)).map((e) => `${e.endpoint} → ${e.statuses.join('/')}`).slice(0, 10),
    server_errors: reqs.filter((r) => r.status >= 500 || r.status === 0).length,
    client_errors: reqs.filter((r) => r.status >= 400 && r.status < 500).length,
    slowest: timed[0] ? `${timed[0].method} ${timed[0].endpoint} ${timed[0].ms}ms` : null,
    console_errors: errors.length,
    errors: errors.slice(0, MAX_ERRORS),
  };
}

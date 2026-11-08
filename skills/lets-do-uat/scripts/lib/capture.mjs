// Screenshot files. Browser tools show a screenshot to the agent but save no
// file, so a page captures itself: the agent runs a snippet in the page that
// renders it with html2canvas and POSTs the PNG to a receiver on 127.0.0.1.
// The receiver writes only names the run expects, only PNG bytes, only into
// that run's shots folder, and only with the run's token. A strict CSP can
// block html2canvas or the POST: that step's screenshot stays inline only.

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import * as S from './state.mjs';

export const MAX_BYTES = 15 << 20;
const IDLE_MS = Number(process.env.LETS_DO_UAT_CAPTURE_IDLE_MS) || 2 * 60 * 60 * 1000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const H2C = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
const infoFile = (runId) => join(S.runDir(runId), 'capture.json');

export const captureInfo = (runId) => {
  try {
    return JSON.parse(readFileSync(infoFile(runId), 'utf8'));
  } catch {
    return null;
  }
};
const sameToken = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const expected = (run) => new Set(run.flows.flatMap((f) => [...f.steps.map((s) => s.shot), f.end_shot]));
// x,y,w,h as fractions of the captured viewport: where the element to use sits on the screenshot.
export const parseBox = (v) => {
  const n = String(v || '').split(',').map(Number);
  return n.length === 4 && n.every((x) => Number.isFinite(x) && x >= 0 && x <= 1) && n[2] > 0 && n[3] > 0 ? n.map((x) => Number(x.toFixed(4))) : null;
};

// Long-running: the receiver itself. Exits after IDLE_MS without a request, or on /stop.
export function serve(runId) {
  const token = randomBytes(16).toString('hex');
  let timer;
  const idle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => server.close(() => process.exit(0)), IDLE_MS);
  };
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    // Chrome's Private Network Access preflight, for an https page posting to 127.0.0.1.
    'Access-Control-Allow-Private-Network': 'true',
  };
  const send = (res, code, body) => res.writeHead(code, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body));
  const server = createServer((req, res) => {
    idle();
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (req.method === 'GET' && u.pathname === '/health') return send(res, 200, { ok: true });
    if (!sameToken(u.searchParams.get('t'), token)) return send(res, 403, { error: 'bad token' });
    if (req.method === 'POST' && u.pathname === '/stop') {
      send(res, 200, { ok: true });
      return server.close(() => process.exit(0));
    }
    if (req.method !== 'POST' || u.pathname !== '/shot') return send(res, 404, { error: 'not found' });
    const name = u.searchParams.get('name') || '';
    let run;
    try {
      run = S.loadRun(runId);
    } catch {
      return send(res, 410, { error: 'run gone' });
    }
    if (!/^[a-z0-9.-]{1,90}\.png$/.test(name) || !expected(run).has(name)) return send(res, 400, { error: 'unexpected name' });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.subarray(0, 8).equals(PNG)) return send(res, 400, { error: 'not a PNG' });
      mkdirSync(run.shots_dir, { recursive: true });
      writeFileSync(join(run.shots_dir, name), buf);
      const box = parseBox(u.searchParams.get('box'));
      // Kept in the run folder, not the docs: it only feeds the highlight in the guide.
      if (box) writeFileSync(join(S.runDir(runId), `${name}.box.json`), JSON.stringify(box));
      send(res, 201, { ok: true, name, bytes: buf.length });
    });
  });
  server.listen(0, '127.0.0.1', () => {
    writeFileSync(infoFile(runId), JSON.stringify({ port: server.address().port, token, pid: process.pid }));
    idle();
  });
}

// Starts the receiver in the background, once per run. -> { port } or { error }
export function startCapture(runId, script) {
  const have = captureInfo(runId);
  if (have && alive(have.pid)) return { port: have.port, reused: true };
  rmSync(infoFile(runId), { force: true });
  const child = spawn(process.execPath, [script, 'serve', '--run', runId], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const info = captureInfo(runId);
    if (info) return { port: info.port, reused: false };
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return { error: 'the capture receiver did not start within 5s' };
}

export function stopCapture(runId) {
  const info = captureInfo(runId);
  if (!info) return { stopped: false };
  try {
    process.kill(info.pid);
  } catch {}
  rmSync(infoFile(runId), { force: true });
  return { stopped: true };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The snippet the agent runs in the page for one screenshot. With target, the
// visible text of the element to use next: its box is sent along, and the guide
// rings it on the picture. Returns "201 box" or "201" (saved), or an error text.
export function snippet(port, token, name, target = '') {
  const url = `http://127.0.0.1:${port}/shot?t=${token}&name=${encodeURIComponent(name)}`;
  return `(async () => { try { const W = innerWidth || document.documentElement.clientWidth || 1280; const H = innerHeight || document.documentElement.clientHeight || 800; const want = ${JSON.stringify(String(target).trim().toLowerCase().slice(0, 120))}; let box = ''; if (want) { const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase(); const els = [...document.querySelectorAll('a,button,input,select,textarea,label,summary,[role],[tabindex],td,th,li,h1,h2,h3,span,div')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && r.bottom > 0 && r.top < H; }); const text = (e) => norm(e.innerText || e.value || e.getAttribute('aria-label') || e.placeholder); const act = (e) => e.matches('a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox]'); const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; }; const rank = (e) => [text(e) === want ? 0 : 1, act(e) ? 0 : 1, area(e)]; const hit = els.filter((e) => text(e).includes(want)).sort((a, b) => { const x = rank(a); const y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; })[0]; if (hit) { const r = hit.getBoundingClientRect(); const c = (v) => Math.min(1, Math.max(0, v)).toFixed(4); box = [c(r.left / W), c(r.top / H), c(r.width / W), c(r.height / H)].join(','); } } if (!window.html2canvas) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = ${JSON.stringify(H2C)}; s.onload = ok; s.onerror = () => no(new Error('html2canvas blocked (CSP?)')); document.head.appendChild(s); }); const c = await window.html2canvas(document.documentElement, { useCORS: true, logging: false, x: scrollX, y: scrollY, width: W, height: H, windowWidth: W, windowHeight: H }); const b = await new Promise((r) => c.toBlob(r, 'image/png')); if (!b) throw new Error('empty canvas: is the browser hidden?'); const r = await fetch(${JSON.stringify(url)} + (box ? '&box=' + box : ''), { method: 'POST', body: await b.arrayBuffer() }); return r.status + (box ? ' box' : want ? ' no-target' : ''); } catch (e) { return 'capture failed: ' + e.message; } })()`;
}

export const shotBox = (run, name) => {
  try {
    return parseBox(JSON.parse(readFileSync(join(S.runDir(run.run_id), `${name}.box.json`), 'utf8')).join(','));
  } catch {
    return null;
  }
};
export const shotExists = (run, name) => existsSync(join(run.shots_dir, name));

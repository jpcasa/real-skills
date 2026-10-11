// Pictures of the screen. The script takes them itself when it can, so a
// picture is a file it made and not one somebody says exists: the user's own
// capture command, Playwright when the repo has it, or a Chrome on this
// machine. When none of those is there, or the screen sits behind a sign-in
// only the browser pane has, an agent takes them and the script checks the files.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME_SHOT = join(dirname(fileURLToPath(import.meta.url)), 'chrome-shot.mjs');
const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];
const onPath = (name) => {
  try {
    return execFileSync('sh', ['-c', `command -v ${name}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
};

// How this run takes pictures. IMPROVE_DESIGN_CAPTURE (tests) or config.capture
// is a shell command with {url} {out} {width} {height}.
export function captureMethod(appDir, config = {}) {
  const command = process.env.IMPROVE_DESIGN_CAPTURE || config.capture || null;
  if (command) return { method: 'command', command };
  if (process.env.IMPROVE_DESIGN_NO_BROWSER) return { method: 'agent' };
  const playwright = join(appDir, 'node_modules/.bin/playwright');
  if (existsSync(playwright)) return { method: 'playwright', bin: playwright };
  const chrome = CHROMES.find(existsSync) || onPath('google-chrome') || onPath('chromium') || onPath('chromium-browser');
  return chrome ? { method: 'chrome', bin: chrome } : { method: 'agent' };
}

// For the user's capture command: a value with anything a shell would read is single-quoted.
const arg = (v) => (/^[A-Za-z0-9_./:%~@=+-]+$/.test(v) ? v : `'${String(v).replace(/'/g, `'\\''`)}'`);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPG = Buffer.from([0xff, 0xd8, 0xff]);
const isImage = (path) => {
  try {
    const head = readFileSync(path).subarray(0, 4);
    return head.equals(PNG) || head.subarray(0, 3).equals(JPG);
  } catch {
    return false;
  }
};

// -> { ok, why? }
export function capture(how, { url, viewport, out, cwd, timeoutS = 60 }) {
  const [width, height] = viewport.split('x');
  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true });
  let r;
  if (how.method === 'command') {
    const cmd = how.command.replaceAll('{url}', arg(url)).replaceAll('{out}', arg(out)).replaceAll('{width}', String(Number(width))).replaceAll('{height}', String(Number(height)));
    r = spawnSync('sh', ['-c', cmd], { cwd, stdio: 'ignore', timeout: timeoutS * 1000, killSignal: 'SIGKILL' });
  } else if (how.method === 'playwright') {
    r = spawnSync(how.bin, ['screenshot', `--viewport-size=${width},${height}`, '--full-page', '--wait-for-timeout=1500', url, out], { cwd, stdio: 'ignore', timeout: timeoutS * 1000, killSignal: 'SIGKILL' });
  } else if (how.method === 'chrome') {
    // Its own process: the viewport is set over the DevTools pipe, see chrome-shot.mjs.
    r = spawnSync(process.execPath, [CHROME_SHOT, how.bin, url, out, width, height], { cwd, stdio: 'ignore', timeout: timeoutS * 1000, killSignal: 'SIGKILL' });
  } else return { ok: false, why: 'no way to take a picture from a script' };
  if (!existsSync(out) || !isImage(out)) return { ok: false, why: `${how.method} wrote no picture${r.status ? ` (exit ${r.status})` : r.signal ? ` (${r.signal})` : ''}` };
  return { ok: true };
}

// A picture counts only when it is a real image file inside the run's own
// shots folder. -> { path, sha, bytes } or null
export function accept(shotsDir, path) {
  try {
    const real = realpathSync(path);
    if (!real.startsWith(realpathSync(shotsDir) + sep)) return null;
    if (!statSync(real).isFile() || !isImage(real)) return null;
    const body = readFileSync(real);
    return { path: real, sha: createHash('sha1').update(body).digest('hex'), bytes: body.length };
  } catch {
    return null;
  }
}

export const shotName = (at, viewport) => `${at}-${viewport}.png`;

// The before and after of one move, per viewport that has both.
// shots: { "<at>": { "<viewport>": {path, sha} } }
export function pairsFor(shots, move, beforeAt) {
  const [before, after] = [shots?.[beforeAt] || {}, shots?.[move.id] || {}];
  return Object.keys(after).filter((v) => before[v]).map((viewport) => ({ move: move.id, viewport, before: before[viewport].path, after: after[viewport].path, identical: before[viewport].sha === after[viewport].sha }));
}

#!/usr/bin/env node
// One full-page picture of one URL at one viewport, from a Chrome on this
// machine. Run as its own process: node chrome-shot.mjs <chrome> <url> <out> <width> <height>
//
// Chrome's own --window-size cannot go below about 500 pixels: a "390 wide"
// picture taken that way is a wider page with its right side cut off. So the
// viewport is set through the DevTools protocol instead, over a pipe (no port,
// no dependency), which reflows the page the way a phone would.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [bin, url, out, w, h] = process.argv.slice(2);
const width = Number(w);
const height = Number(h);
const MAX_HEIGHT = 12000;
const SETTLE_MS = 1200;
const profile = mkdtempSync(join(tmpdir(), 'improve-design-chrome-'));

const chrome = spawn(bin, ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-extensions', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const [toChrome, fromChrome] = [chrome.stdio[3], chrome.stdio[4]];

let seq = 0;
const waiting = new Map();
const events = [];
const listeners = [];
let buffer = Buffer.alloc(0);
fromChrome.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  let end;
  while ((end = buffer.indexOf(0)) !== -1) {
    const msg = JSON.parse(buffer.subarray(0, end).toString());
    buffer = buffer.subarray(end + 1);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg.method);
      for (const l of listeners.splice(0)) l();
    }
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    toChrome.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
const event = async (name) => {
  while (!events.includes(name)) await new Promise((r) => listeners.push(r));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function finish(code, why) {
  try {
    chrome.kill('SIGKILL');
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  if (why) process.stderr.write(`${why}\n`);
  process.exit(code);
}
const timer = setTimeout(() => finish(3, 'timed out'), 45000);
chrome.on('error', (e) => finish(2, e.message));

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 }, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url }, sessionId);
  await event('Page.loadEventFired');
  await sleep(SETTLE_MS); // fonts, a first data fetch, an entrance animation
  // A page with no viewport meta is laid out wider than a phone and shown
  // zoomed out. The picture covers the whole layout width, scaled to the
  // viewport, which is what the phone shows; cutting at `width` would crop it.
  const { cssContentSize, cssLayoutViewport } = await send('Page.getLayoutMetrics', {}, sessionId);
  const layoutWidth = Math.max(1, Math.round(cssLayoutViewport?.clientWidth || width));
  const scale = width / layoutWidth;
  const layoutHeight = Math.max(cssLayoutViewport?.clientHeight || height, Math.ceil(cssContentSize?.height || 0));
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: layoutWidth, height: Math.min(layoutHeight, MAX_HEIGHT / scale), scale } }, sessionId);
  writeFileSync(out, Buffer.from(data, 'base64'));
  clearTimeout(timer);
  finish(0);
} catch (e) {
  clearTimeout(timer);
  finish(1, e.message);
}

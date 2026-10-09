// Jev calibration: run every fixture through the live API, then sweep
// thresholds per question family and report the best F1. Does NOT edit
// THRESHOLDS; a human applies them after review.
//
// Fixture (scripts/eval/fixtures/*.json):
// { "id": "...", "source": "acme PR #123 / CU-abc", "builder": "roleNeeds|loopDecision|mergeGate|qaFailure|sharesInterface|pairwise",
//   "state": {...}, "pairs": [[0,1]] (pairwise only), "expected": { "<question id>": true|false } }
//
// Usage: node scripts/eval/run.mjs [--no-cache]

import { readdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask } from '../lib/jev.mjs';
import * as Q from '../lib/questions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures');
const CACHE = join(here, 'cache.json');
const RESULTS = join(here, 'results.json');

const family = (id) =>
  id.startsWith('needs_') ? 'needs_role' : id.startsWith('overlap__') ? 'overlap' : id.startsWith('depends__') ? 'depends_on' : id;

export function sweep(points) {
  // points: [{p, y}]; returns the best-F1 threshold (middle of any tie plateau)
  const all = [];
  for (let t = 0.3; t <= 0.8001; t += 0.05) {
    let tp = 0, fp = 0, fn = 0, ok = 0;
    for (const { p, y } of points) {
      const yhat = p >= t;
      if (yhat && y) tp++;
      if (yhat && !y) fp++;
      if (!yhat && y) fn++;
      if (yhat === y) ok++;
    }
    const f1 = tp ? (2 * tp) / (2 * tp + fp + fn) : 0;
    all.push({ threshold: Number(t.toFixed(2)), f1: Number(f1.toFixed(3)), accuracy: Number((ok / points.length).toFixed(3)) });
  }
  // Best F1 (then accuracy); on a plateau of equally good thresholds take the middle.
  const top = all.reduce((m, c) => (c.f1 > m.f1 || (c.f1 === m.f1 && c.accuracy > m.accuracy) ? c : m));
  const plateau = all.filter((c) => c.f1 === top.f1 && c.accuracy === top.accuracy);
  return { ...plateau[Math.floor((plateau.length - 1) / 2)], plateau: [plateau[0].threshold, plateau.at(-1).threshold] };
}

async function main() {
  const noCache = process.argv.includes('--no-cache');
  const cache = !noCache && existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
  const files = readdirSync(FIX).filter((f) => f.endsWith('.json'));
  const points = {};
  const errors = [];
  for (const f of files) {
    const fx = JSON.parse(readFileSync(join(FIX, f), 'utf8'));
    const built = fx.builder === 'pairwise' ? Q.pairwise(fx.state, fx.pairs) : Q[fx.builder](fx.state);
    let answers = cache[fx.id];
    if (!answers) {
      const r = await ask(built);
      if (r.degraded) {
        errors.push({ id: fx.id, error: r.error });
        continue;
      }
      answers = r.answers;
      cache[fx.id] = answers;
    }
    for (const [qid, y] of Object.entries(fx.expected)) {
      const a = answers[qid];
      if (!a) {
        errors.push({ id: fx.id, error: `no answer for ${qid}` });
        continue;
      }
      const p = a.type === 'noul' ? a.noul : a.type === 'score' ? Q.normScore(a, 3) : a.choice === y ? 1 : 0;
      (points[family(qid)] ??= []).push({ p, y: a.type === 'choice' ? true : Boolean(y), fixture: fx.id, qid });
    }
  }
  writeFileSync(CACHE, JSON.stringify(cache, null, 2));
  const report = {};
  for (const [fam, pts] of Object.entries(points)) {
    const cur = Q.THRESHOLDS[fam] ?? Q.DEFAULT_THRESHOLD;
    const atCur = pts.filter(({ p, y }) => (p >= cur) === y).length / pts.length;
    const best = sweep(pts);
    report[fam] = {
      n: pts.length, positives: pts.filter((x) => x.y).length, current: cur,
      accuracy_at_current: Number(atCur.toFixed(3)), best,
      misses_at_best: pts.filter(({ p, y }) => (p >= best.threshold) !== y).map((x) => `${x.fixture}:${x.qid} p=${x.p.toFixed(2)} y=${x.y}`),
      flag: best.accuracy < 0.7 ? 'accuracy < 0.7: reword before trusting' : null,
    };
  }
  writeFileSync(RESULTS, JSON.stringify({ fixtures: files.length, errors, report }, null, 2));
  process.stdout.write(`${JSON.stringify({ fixtures: files.length, errors: errors.length, report })}\n`);
}

// Real paths on both sides: import.meta.url is percent-encoded and has symlinks
// resolved, process.argv[1] is neither, so a string comparison fails for an
// install path with a space or a symlink in it.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main();

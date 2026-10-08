// Unified-diff parsing for a PR, the built-in ignore list, and chunking of a
// diff too large for one reviewer.

import { anyMatch } from './glob.mjs';

// -> [{ file, old_file?, deleted, binary, added, removed, lines: Set<new-side line in a hunk> }]
export function parsePatch(text) {
  const files = [];
  let cur = null;
  let n = 0;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      cur = { file: m ? m[2] : '', deleted: false, binary: false, added: 0, removed: 0, lines: new Set() };
      files.push(cur);
      n = 0;
      continue;
    }
    if (!cur) continue;
    if (n === 0) {
      if (line.startsWith('rename from ')) cur.old_file = line.slice(12);
      else if (line.startsWith('rename to ')) cur.file = line.slice(10);
      else if (line.startsWith('deleted file mode')) cur.deleted = true;
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) cur.binary = true;
      else if (line.startsWith('+++ b/')) cur.file = line.slice(6);
    }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      n = Number(h[1]);
      continue;
    }
    if (n === 0) continue;
    if (line.startsWith('+')) {
      cur.lines.add(n++);
      cur.added += 1;
    } else if (line.startsWith('-')) cur.removed += 1;
    else if (line.startsWith(' ')) cur.lines.add(n++);
    // "\ No newline at end of file" and anything else: not a line of the file.
  }
  return files;
}

export const DEFAULT_IGNORE = [
  '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/bun.lockb', '**/Cargo.lock', '**/poetry.lock',
  '**/Gemfile.lock', '**/go.sum', '**/composer.lock', '**/uv.lock',
  '**/*.snap', '**/__snapshots__/**', '**/*.min.js', '**/*.min.css', '**/*.map',
  '**/dist/**', '**/build/**', '**/vendor/**', '**/node_modules/**', '**/generated/**', '**/*.generated.*',
  '**/*.{png,jpg,jpeg,gif,webp,ico,pdf,woff,woff2,ttf,eot,zip,gz,mp4,mov}',
];
export const isIgnored = (path, extra = []) => anyMatch([...DEFAULT_IGNORE, ...extra], path);

export const LIMIT = 1500;
export const MAX_CHUNKS = 4;
const size = (f) => f.added + f.removed;
const top = (f) => (f.file.includes('/') ? f.file.split('/')[0] : '.');

// One chunk when the diff fits. Otherwise files are packed in directory order
// into at most `max` chunks of `limit` changed lines; what is left over is
// listed, never silently skipped. A single file over the limit gets a chunk to
// itself: a file cannot be split.
export function chunk(files, { limit = LIMIT, max = MAX_CHUNKS } = {}) {
  const total = files.reduce((s, f) => s + size(f), 0);
  if (total <= limit) return { chunks: files.length ? [files.map((f) => f.file)] : [], not_reviewed: [] };
  const sorted = [...files].sort((a, b) => top(a).localeCompare(top(b)) || a.file.localeCompare(b.file));
  const chunks = [];
  const not_reviewed = [];
  let cur = null;
  let used = 0;
  for (const f of sorted) {
    if (cur && used + size(f) <= limit) {
      cur.push(f.file);
      used += size(f);
    } else if (chunks.length < max) {
      cur = [f.file];
      used = size(f);
      chunks.push(cur);
    } else not_reviewed.push(f.file);
  }
  return { chunks, not_reviewed };
}

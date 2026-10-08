// Tiny glob matcher: `**` (any depth, incl. zero dirs), `*` (within a segment),
// `?`, `{a,b}`. Paths are repo-relative with forward slashes.

const cache = new Map();

function toRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{' && glob.indexOf('}', i) !== -1) {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function globMatch(glob, path) {
  if (!cache.has(glob)) cache.set(glob, toRegExp(glob));
  return cache.get(glob).test(path);
}

export const anyMatch = (globs, path) => globs.some((g) => globMatch(g, path));

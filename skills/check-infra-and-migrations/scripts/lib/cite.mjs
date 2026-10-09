// "file:line or it did not happen", checked against the file as it is at the
// head of the change. A citation counts only when the line is in range and
// the quoted text is really there, within a few lines. This proves the line
// exists and says what was quoted. It does not prove the reading of it.

export const WINDOW = 3;
// Shorter quotes ("return", "} else {") occur everywhere and prove nothing.
export const MIN_QUOTE = 12;
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

// headText(file) -> the file's text at the head, or null.
// -> { ok: true } | { ok: false, why }
export function checkCitation(f, headText) {
  if (typeof f.file !== 'string' || !f.file || f.file.startsWith('/') || f.file.split('/').includes('..')) return { ok: false, why: 'no file, or a path outside the repository' };
  const text = headText(f.file);
  if (text == null) return { ok: false, why: `${f.file} does not exist at the head` };
  const lines = text.split('\n');
  if (!Number.isInteger(f.line) || f.line < 1 || f.line > lines.length) return { ok: false, why: `line out of range (${f.file} has ${lines.length} lines)` };
  const quote = squash(f.quote || '');
  if (quote.length < MIN_QUOTE) return { ok: false, why: `quote is missing or too short to check (at least ${MIN_QUOTE} characters)` };
  const near = squash(lines.slice(Math.max(0, f.line - 1 - WINDOW), f.line + WINDOW).join(' '));
  if (!near.includes(quote)) return { ok: false, why: `quote not found within ${WINDOW} lines of line ${f.line}` };
  return { ok: true };
}

// Code rules for one PR: which ticket is its own, and which flags its paths
// set. No model involved. A ticket is only ever an ID found in the PR's own
// branch name, body, or GitHub closing references.

const DECLARES = /\b(fix(es|ed)?|close[sd]?|resolve[sd]?|ticket|task|issue|story|clickup|linear|jira|asana|shortcut)\b[^\n]*$/i;
const MIGRATION = /(^|\/)(migrations?|drizzle|supabase\/migrations)\/|\.sql$/i;
const DOCS = /(^|\/)docs\/|\.(md|mdx|rst|txt)$/i;

const uniq = (xs) => [...new Set(xs)];
const norm = (id, type) => (type === 'linear' ? id.toUpperCase() : id);

function idsIn(text, pattern, type) {
  const re = new RegExp(pattern, 'gi');
  return [...String(text || '').matchAll(re)].map((m) => ({ id: norm(m[0], type), index: m.index }));
}

// pr: { branch, body, closing_issues?: [n] }   tracker: { type, id_pattern }
// -> { ticket, source: github_link|branch|body_declared|null, candidates: [ids], error? }
export function resolveTicket(pr, tracker = {}) {
  const type = tracker.type || 'none';
  if (type === 'none') return { ticket: null, source: null, candidates: [] };

  if (type === 'github') {
    const closing = (pr.closing_issues || []).map(String);
    const branch = [...String(pr.branch || '').matchAll(/(?:^|\/)(\d+)[-_]/g)].map((m) => m[1]);
    const declared = [...String(pr.body || '').matchAll(/\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi)].map((m) => m[1]);
    const candidates = uniq([...closing, ...branch, ...declared]);
    if (closing.length) return { ticket: closing[0], source: 'github_link', candidates };
    if (branch.length) return { ticket: branch[0], source: 'branch', candidates };
    if (declared.length) return { ticket: declared[0], source: 'body_declared', candidates };
    return { ticket: null, source: null, candidates };
  }

  if (!tracker.id_pattern) return { ticket: null, source: null, candidates: [], error: 'tracker.id_pattern is not set' };
  let inBranch;
  let inBody;
  try {
    inBranch = idsIn(pr.branch, tracker.id_pattern, type);
    inBody = idsIn(pr.body, tracker.id_pattern, type);
  } catch (e) {
    return { ticket: null, source: null, candidates: [], error: `tracker.id_pattern is not a valid regex: ${e.message}` };
  }
  const candidates = uniq([...inBranch, ...inBody].map((m) => m.id));
  if (inBranch.length) return { ticket: inBranch[0].id, source: 'branch', candidates };
  // The body presents an ID as the ticket when a declaring word precedes it on its line.
  const body = String(pr.body || '');
  const declared = inBody.find((m) => DECLARES.test(body.slice(Math.max(0, m.index - 120), m.index)));
  if (declared) return { ticket: declared.id, source: 'body_declared', candidates };
  return { ticket: null, source: null, candidates };
}

// files: [paths]
export function pathFlags(files = []) {
  return {
    migration: files.some((f) => MIGRATION.test(f)),
    migration_files: files.filter((f) => MIGRATION.test(f)),
    docs_only: files.length > 0 && files.every((f) => DOCS.test(f)),
  };
}

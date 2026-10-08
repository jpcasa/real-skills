// Which lenses review a PR. Two always run; the rest join on a path rule or
// when asked for by name. Jev may add one once its question is calibrated.

export const LENSES = ['correctness', 'standards', 'security', 'data', 'performance', 'accessibility'];
export const ALWAYS = ['correctness', 'standards'];
export const OPTIONAL = LENSES.filter((l) => !ALWAYS.includes(l));

export const DEFAULT_PATH_RULES = [
  { pattern: '(^|/)(auth|session|login|oauth|payments?|billing|stripe|rls|polic(y|ies)|secrets?|credentials?|permissions?)([/._-]|$)', lenses: ['security'] },
  { pattern: '(^|/)(migrations?|drizzle|supabase)/|(^|/)schema[^/]*$|\\.sql$', lenses: ['data'] },
  { pattern: '\\.sql$|(^|/)(queries|repositories|resolvers|loaders)/', lenses: ['performance'] },
  { pattern: '\\.(tsx|jsx|vue|svelte|html|css|scss)$', lenses: ['accessibility'] },
];

const safeRe = (src) => {
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
};

// -> { lenses: [name] in LENSES order, reasons: { name: why } }
export function pickLenses({ files = [], pathRules = DEFAULT_PATH_RULES, forced = [] }) {
  const reasons = Object.fromEntries(ALWAYS.map((l) => [l, 'always']));
  for (const rule of pathRules) {
    const re = safeRe(rule.pattern);
    if (!re) continue;
    const hit = files.find((f) => re.test(f));
    if (!hit) continue;
    for (const l of rule.lenses || []) if (LENSES.includes(l)) reasons[l] ??= `path rule: ${hit}`;
  }
  const unknown = forced.filter((l) => !LENSES.includes(l));
  if (unknown.length) throw new Error(`unknown lens ${unknown.join(', ')}; use ${LENSES.join(' | ')}`);
  for (const l of forced) reasons[l] ??= '--lens';
  return { lenses: LENSES.filter((l) => reasons[l]), reasons };
}

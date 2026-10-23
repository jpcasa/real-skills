// Run-level planning: clusters -> teams, dependencies -> stacks, spawn estimate,
// merge order. Pure functions; Jev answers are passed in already normalized.

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Union-find over pairs with overlap >= threshold. Keeps input order.
export function cluster(ids, overlap, threshold) {
  const parent = Object.fromEntries(ids.map((i) => [i, i]));
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const [k, v] of Object.entries(overlap)) {
    if (v < threshold) continue;
    const [a, b] = k.split('|');
    if (a in parent && b in parent) parent[find(a)] = find(b);
  }
  const groups = new Map();
  for (const id of ids) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(id);
  }
  return [...groups.values()];
}

const mentions = (leaf, other) => {
  const refs = [other.id, other.ref].filter(Boolean).map(String);
  const dep = (leaf.plan?.depends_on || []).map(String);
  const blocked = (leaf.links?.blocked_by || []).map(String);
  return refs.some((r) => dep.includes(r) || blocked.includes(r));
};

// Edge [a, b] means b needs a. Evidence (investigator depends_on or tracker
// blocked_by) is required; in live mode Jev must also agree.
export function dependencies(leaves, jevDeps, mode, threshold) {
  const edges = [];
  for (const b of leaves) {
    for (const a of leaves) {
      if (a.id === b.id || !mentions(b, a)) continue;
      const tracker = (b.links?.blocked_by || []).map(String).some((r) => r === a.id || r === a.ref);
      const p = jevDeps[`${a.id}>${b.id}`];
      if (mode === 'live' && !tracker && !(typeof p === 'number' && p >= threshold)) continue;
      edges.push([a.id, b.id]);
    }
  }
  return edges;
}

// Kahn's algorithm, stable on input order.
export function topoOrder(ids, edges) {
  const indeg = Object.fromEntries(ids.map((i) => [i, 0]));
  for (const [, b] of edges) if (b in indeg) indeg[b]++;
  const order = [];
  const ready = ids.filter((i) => indeg[i] === 0);
  while (ready.length) {
    const n = ready.shift();
    order.push(n);
    for (const [a, b] of edges) {
      if (a !== n || !(b in indeg)) continue;
      if (--indeg[b] === 0) ready.push(b);
    }
    ready.sort((x, y) => ids.indexOf(x) - ids.indexOf(y));
  }
  const cycle = ids.filter((i) => !order.includes(i));
  return { order, cycle };
}

export function estimateSpawns(leaves, { architect = false } = {}) {
  // loop 1 (investigator already spawned) + an assumed fix loop (worker + tester)
  return leaves.reduce((n, l) => n + (l.roles.length - 1) + 2, 0) + (architect ? 1 : 0);
}

export const TEAM_NAMES = ['Falcon', 'Heron', 'Kestrel', 'Osprey', 'Raven', 'Swift', 'Wren', 'Ibis', 'Merlin', 'Plover', 'Robin', 'Tern'];
export const teamName = (i) => TEAM_NAMES[i % TEAM_NAMES.length] + (i >= TEAM_NAMES.length ? ` ${Math.floor(i / TEAM_NAMES.length) + 1}` : '');

// leaves: [{id, ref, roles, plan:{files, depends_on}, links:{blocked_by}}]
// overlap: {"a|b": 0..1}; jevDeps: {"a>b": p}
// overlapPolicy "parallel": only dependencies put leaves in one team; shared
// files are built apart and merged in order. "serialize": overlap joins too.
export function computePlan({ leaves, overlap = {}, jevDeps = {}, mode = 'shadow', thresholds = {}, architect = false, overlapPolicy = 'parallel' }) {
  const ids = leaves.map((l) => l.id);
  const warnings = [];
  let edges = dependencies(leaves, jevDeps, mode, thresholds.depends_on ?? 0.6);
  const t = topoOrder(ids, edges);
  if (t.cycle.length) {
    warnings.push(`dependency cycle between ${t.cycle.join(', ')}; stacks dropped for them`);
    edges = edges.filter(([a, b]) => !t.cycle.includes(a) && !t.cycle.includes(b));
  }
  const order = topoOrder(ids, edges).order;
  // Dependent leaves join the same cluster so one team builds them in order.
  const overlapAt = thresholds.overlap ?? 0.5;
  const joined = overlapPolicy === 'serialize' ? { ...overlap } : {};
  for (const [a, b] of edges) joined[pairKey(a, b)] = 1;
  const clusters = cluster(order, joined, overlapAt);
  const teams = clusters.map((leavesInTeam, i) => ({ team_id: `t${i + 1}`, name: teamName(i), leaves: leavesInTeam }));
  // Not a warning (warnings veto the checkpoint): shown, merged in order, conflicts go to the integrator.
  const teamOfLeaf = Object.fromEntries(teams.flatMap((t) => t.leaves.map((l) => [l, t.team_id])));
  const sharedFiles = Object.entries(overlap)
    .filter(([k, v]) => v >= overlapAt && teamOfLeaf[k.split('|')[0]] !== teamOfLeaf[k.split('|')[1]])
    .map(([k]) => k.split('|'));

  // One stack parent per leaf: its latest-built dependency.
  const stacks = {};
  for (const id of order) {
    const deps = edges.filter(([, b]) => b === id).map(([a]) => a);
    if (deps.length) stacks[id] = deps.sort((x, y) => order.indexOf(y) - order.indexOf(x))[0];
    if (deps.length > 1) warnings.push(`${id} depends on ${deps.join(', ')}; stacked on ${stacks[id]} only`);
  }
  // Waves: dependency depth.
  const depth = {};
  for (const id of order) depth[id] = Math.max(0, ...edges.filter(([, b]) => b === id).map(([a]) => depth[a] + 1));
  const waves = [];
  for (const id of order) (waves[depth[id]] ??= []).push(id);

  return { teams, clusters, stacks, waves, edges, overlap, shared_files: sharedFiles, warnings, estimate: estimateSpawns(leaves, { architect }) };
}

// Stack parents before children; otherwise lowest total overlap first.
export function mergeOrder(ids, plan = {}) {
  const ov = plan.overlap || {};
  const load = (id) => Object.entries(ov).reduce((s, [k, v]) => (k.split('|').includes(id) ? s + v : s), 0);
  const byLoad = [...ids].sort((a, b) => load(a) - load(b) || ids.indexOf(a) - ids.indexOf(b));
  const edges = Object.entries(plan.stacks || {}).map(([child, parent]) => [parent, child]);
  return topoOrder(byLoad, edges).order;
}

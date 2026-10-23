// Run/team state store for /do-shit. Lives outside the repo so it survives
// worktree removal and app quits: ~/.claude/state/do-shit/<run-id>/
//   run.json  teams/<team-id>.json  events.jsonl  qa/<item>/*.png
// Override the root with DO_SHIT_STATE_DIR (tests).

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const stateRoot = () => process.env.DO_SHIT_STATE_DIR || join(homedir(), '.claude/state/do-shit');
export const runDir = (id) => join(stateRoot(), id);

function writeAtomic(path, obj) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, path);
}

function readJson(path, what) {
  if (!existsSync(path)) throw new Error(`unknown ${what}: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function newRun({ repo, base, tracker, dryRun = false, spawnCap = 60, mode = 'shadow' }) {
  const slug = basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    run_id: `${slug}--${stamp()}-${randomBytes(2).toString('hex')}`,
    created_at: new Date().toISOString(),
    repo,
    base,
    tracker,
    mode,
    dry_run: dryRun,
    phase: 'intake',
    spawn_cap: spawnCap,
    spawns_used: 0,
    items: [],
    teams: [],
    plan: {},
    merge_plan: [],
    qa: {},
  };
}

export function newTeam(runId, { leaves, roles, teamId, name = null }) {
  return {
    team_id: teamId || `t${randomBytes(2).toString('hex')}`,
    name,
    leaves,
    current_leaf: leaves[0] ?? null,
    loop: 0,
    max_loops: 3,
    stage: 'queued',
    roles,
    pending: [],
    leaf_state: {},
    history: [],
    outcome: null,
  };
}

export function saveRun(run) {
  mkdirSync(join(runDir(run.run_id), 'teams'), { recursive: true });
  writeAtomic(join(runDir(run.run_id), 'run.json'), run);
}

export const loadRun = (id) => readJson(join(runDir(id), 'run.json'), 'run');

export function saveTeam(runId, team) {
  mkdirSync(join(runDir(runId), 'teams'), { recursive: true });
  writeAtomic(join(runDir(runId), 'teams', `${team.team_id}.json`), team);
}

export const loadTeam = (runId, teamId) => readJson(join(runDir(runId), 'teams', `${teamId}.json`), 'team');

export function loadTeams(runId) {
  const d = join(runDir(runId), 'teams');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')));
}

export function appendEvent(runId, evt) {
  mkdirSync(runDir(runId), { recursive: true });
  appendFileSync(join(runDir(runId), 'events.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...evt })}\n`);
}

export function listRuns() {
  if (!existsSync(stateRoot())) return [];
  return readdirSync(stateRoot()).filter((d) => existsSync(join(stateRoot(), d, 'run.json')));
}

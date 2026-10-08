// <repo>/.claude/review-prs.json. Every key is optional and there is no setup step.
// { standards: [paths], path_rules: [{pattern, lenses}], ignore: [globs], max_nits, jev }

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_NITS } from './rules.mjs';

const read = (repo, name) => {
  const p = join(repo, '.claude', name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

export function loadConfig(repo) {
  const c = read(repo, 'review-prs.json') || {};
  // The ticket-id pattern is a question /wtf or /changelog already answered.
  const tracker = read(repo, 'wtf.json')?.tracker || read(repo, 'changelog.json')?.tracker || null;
  return {
    standards: c.standards || ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md'],
    path_rules: c.path_rules || [],
    ignore: c.ignore || [],
    max_nits: Number.isInteger(c.max_nits) ? c.max_nits : MAX_NITS,
    jev: c.jev || 'shadow',
    ticket_pattern: tracker?.id_pattern || null,
  };
}

export const jevMode = (config) => {
  const m = process.env.REVIEW_PRS_JEV || config.jev || 'shadow';
  return m === 'live' ? 'live' : m === 'off' || m === '0' ? 'off' : 'shadow';
};

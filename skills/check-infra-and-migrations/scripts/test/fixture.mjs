// A small app with Drizzle migrations and a CDK stack, built in a temp folder,
// plus the `gh` answers that go with it. Shared by check.test.mjs and live.test.mjs.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
export const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
export const write = (repo, file, text) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
};
export const commit = (repo, message) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
};

export const journal = (...tags) => `${JSON.stringify({ version: '7', dialect: 'postgresql', entries: tags.map((tag, idx) => ({ idx, tag })) }, null, 2)}\n`;
export const STACK = [
  "export class DataStack extends Stack {",
  "  constructor(scope, id) {",
  "    super(scope, id);",
  "    new s3.Bucket(this, 'Uploads', {",
  "      versioned: true,",
  "    });",
  "    new rds.DatabaseInstance(this, 'Main', {",
  "      deletionProtection: true,",
  "    });",
  "  }",
  "}",
  '',
].join('\n');

// -> { tmp, repo, stubFile, sha: { base, feat, docs }, setStub(extra) }
// main and production start at `base`. `feat` drops a column, builds an index,
// removes a bucket and adds an env name. `docs` touches nothing this skill reads.
export function makeApp(prefix = 'cim-') {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const repo = join(tmp, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'db/migrations/0000_init.sql', 'CREATE TABLE users (id uuid PRIMARY KEY, legacy_id text, email text);\n');
  write(repo, 'db/migrations/meta/_journal.json', journal('0000_init'));
  write(repo, 'infra/cdk.json', '{ "app": "npx ts-node bin/infra.ts" }\n');
  write(repo, 'infra/lib/data-stack.ts', STACK);
  write(repo, 'src/users.ts', "export const q = 'select legacy_id from users';\nexport const read = (row) => row.legacyId;\n");
  write(repo, '.env.example', 'DATABASE_URL=\n');
  write(repo, '.github/workflows/deploy.yml', 'jobs:\n  deploy:\n    steps:\n      - run: pnpm drizzle-kit migrate\n      - run: pnpm cdk deploy --all\n');
  write(repo, '.gitignore', '.claude/\n');
  const base = commit(repo, 'init');
  git(repo, 'branch', 'production');

  git(repo, 'checkout', '-q', '-b', 'feat');
  write(repo, 'db/migrations/0001_drop_legacy.sql', [
    'ALTER TABLE users DROP COLUMN legacy_id;',
    '--> statement-breakpoint',
    'CREATE INDEX users_email_idx ON users (email);',
    '--> statement-breakpoint',
    'CREATE TABLE things (id uuid PRIMARY KEY);',
    '--> statement-breakpoint',
    'CREATE INDEX things_idx ON things (id);',
    '',
  ].join('\n'));
  write(repo, 'db/migrations/meta/_journal.json', journal('0000_init', '0001_drop_legacy'));
  write(repo, 'infra/lib/data-stack.ts', STACK.replace("    new s3.Bucket(this, 'Uploads', {\n      versioned: true,\n    });\n", '').replace('deletionProtection: true,', 'deletionProtection: true,\n      removalPolicy: RemovalPolicy.DESTROY,'));
  write(repo, '.env.example', 'DATABASE_URL=\nSTRIPE_KEY=\n');
  write(repo, 'src/other.ts', 'export const x = 1;\n');
  const feat = commit(repo, 'drop legacy id');

  git(repo, 'checkout', '-q', 'main');
  git(repo, 'checkout', '-q', '-b', 'docs');
  write(repo, 'src/notes.ts', '// nothing to see\n');
  const docs = commit(repo, 'notes');
  git(repo, 'checkout', '-q', 'main');

  const stubFile = join(tmp, 'gh.json');
  const view = (number, title, baseRefName, baseRefOid, headRefName, headRefOid, state = 'OPEN') => ({ view: { number, title, baseRefName, baseRefOid, headRefName, headRefOid, state, url: `https://github.com/acme/app/pull/${number}` } });
  const prs = { 7: view(7, 'Drop legacy id', 'main', base, 'feat', feat), 8: view(8, 'Notes', 'main', base, 'docs', docs), 9: view(9, 'Release', 'production', base, 'feat', feat) };
  const setStub = (extra = {}) => writeFileSync(stubFile, JSON.stringify({ slug: 'acme/app', prs: { ...prs, ...(extra.prs || {}) }, open_into: {}, current_pr: null, ...extra, prs: { ...prs, ...(extra.prs || {}) } }));
  setStub();
  return { tmp, repo, stubFile, sha: { base, feat, docs }, view, setStub };
}

// A branch off `from` with the given files, and a PR view for it. -> head sha
export function branch(app, name, from, files, message = name) {
  git(app.repo, 'checkout', '-q', '-b', name, from);
  for (const [file, text] of Object.entries(files)) write(app.repo, file, text);
  const sha = commit(app.repo, message);
  git(app.repo, 'checkout', '-q', 'main');
  return sha;
}

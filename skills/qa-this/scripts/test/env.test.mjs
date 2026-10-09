import { test } from 'node:test';
import assert from 'node:assert/strict';

const { envRefusal, allowedEnvs } = await import('../lib/env.mjs');

const config = {
  production_hosts: ['app.example.com', 'https://eu.example.org:443/'],
  environments: [
    { name: 'local', kind: 'local', base_url: 'http://localhost:3000' },
    { name: 'staging', kind: 'staging', base_url: 'https://staging.example.com' },
    { name: 'prod', kind: 'production', base_url: 'https://app.example.com' },
    { name: 'sneaky', kind: 'staging', base_url: 'https://APP.example.com.:8443/x' },
    { name: 'sub', kind: 'preview', base_url: 'https://pr-1.app.example.com' },
    { name: 'eu', kind: 'staging', base_url: 'https://eu.example.org' },
    { name: 'nourl', kind: 'local' },
  ],
};

test('local and staging on a non-production host are allowed', () => {
  assert.equal(envRefusal(config, 'local'), null);
  assert.equal(envRefusal(config, 'staging'), null);
  assert.deepEqual(allowedEnvs(config), ['local', 'staging']);
});

test('production is refused by kind, by host, by subdomain and through a port or trailing dot', () => {
  assert.match(envRefusal(config, 'prod'), /kind production/);
  assert.match(envRefusal(config, 'sneaky'), /production host/);
  assert.match(envRefusal(config, 'sub'), /production host/);
  assert.match(envRefusal(config, 'eu'), /production host/);
});

test('an unknown or unusable environment is refused', () => {
  assert.match(envRefusal(config, 'nope'), /no environment named/);
  assert.match(envRefusal(config, 'nourl'), /base_url/);
  assert.match(envRefusal(config, null), /no environment chosen/);
});

test('a wildcard entry covers the host and everything under it; any other "*" refuses the config', () => {
  const wild = { ...config, production_hosts: ['*.example.com'] };
  assert.match(envRefusal(wild, 'staging'), /production host/);
  assert.match(envRefusal(wild, 'sub'), /production host/);
  assert.equal(envRefusal(wild, 'local'), null);
  assert.match(envRefusal({ ...config, production_hosts: ['app.*.com'] }, 'local'), /not a host/);
});

test('without production_hosts nothing is allowed', () => {
  const bare = { environments: config.environments };
  assert.match(envRefusal(bare, 'local'), /production_hosts is empty/);
  assert.deepEqual(allowedEnvs(bare), []);
  assert.match(envRefusal({ ...config, production_hosts: ['not a host'] }, 'local'), /not a host/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { envRefusal, allowedEnvs, prodHostsText } = await import('../lib/env.mjs');

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

test('"=" means that host exactly: a port or trailing dot does not hide it, a host under it is allowed', () => {
  const envs = [
    { name: 'prod', kind: 'staging', base_url: 'https://app.echo1.co' },
    { name: 'port', kind: 'staging', base_url: 'https://APP.echo1.co:8443/x' },
    { name: 'dot', kind: 'staging', base_url: 'https://app.echo1.co./' },
    { name: 'staging', kind: 'staging', base_url: 'https://staging.app.echo1.co' },
  ];
  for (const entry of ['=app.echo1.co', '=https://app.echo1.co', '=https://app.echo1.co:443/', ' =APP.echo1.co. ']) {
    const exact = { production_hosts: [entry, 'internal.echo1.co'], environments: envs };
    for (const name of ['prod', 'port', 'dot']) assert.match(envRefusal(exact, name), /app\.echo1\.co is a production host/, `${entry} ${name}`);
    assert.equal(envRefusal(exact, 'staging'), null, entry);
    assert.deepEqual(allowedEnvs(exact), ['staging'], entry);
  }
  // A bare entry keeps its meaning: the host and everything under it.
  assert.match(envRefusal({ production_hosts: ['app.echo1.co'], environments: envs }, 'staging'), /staging\.app\.echo1\.co is a production host/);
  assert.deepEqual(allowedEnvs({ production_hosts: ['*.app.echo1.co'], environments: envs }), []);
});

test('"=" with a "*", "=" alone, or a stray "=" refuses the whole config', () => {
  const envs = [{ name: 'local', kind: 'local', base_url: 'http://localhost:3000' }];
  for (const entry of ['=*.echo1.co', '=https://*.echo1.co', '*.=echo1.co', '=', ' = ', '==app.echo1.co', '= app.echo1.co', 'app=echo1.co', '=https://']) {
    const bad = { production_hosts: ['internal.echo1.co', entry], environments: envs };
    assert.match(envRefusal(bad, 'local'), /not a host/, JSON.stringify(entry));
    assert.deepEqual(allowedEnvs(bad), [], JSON.stringify(entry));
  }
});

test('the tester is told which hosts are exact and which cover everything under them', () => {
  assert.equal(prodHostsText({ production_hosts: ['=https://app.echo1.co', '*.okridecare.com'] }), 'app.echo1.co (that host only), okridecare.com (and every host under it)');
});

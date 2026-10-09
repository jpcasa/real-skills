// Which environments /qa-this may touch. The same rule as /wtf's reproduction:
// the kind must be local, preview or staging, and the host must not be, or sit
// under, a listed production host. With no production hosts listed, no URL can
// be shown to be non-production, so nothing that touches an environment runs.

export const ENV_KINDS = ['local', 'preview', 'staging'];

// Hostname only, lower-cased, no trailing dot: a port or a fully-qualified
// "host." must not make a production host look like something else.
const norm = (h) => String(h || '').trim().toLowerCase().replace(/\.+$/, '');
export const hostOf = (url) => {
  try {
    return norm(new URL(url).hostname) || null;
  } catch {
    return null;
  }
};
// production_hosts entries may be written as bare hosts or as URLs, with or without a port.
// "*.example.com" means the same as "example.com": the host and everything under it.
// Any other "*" is not a host, and the whole config is refused rather than guessed at.
const prodHost = (entry) => {
  const e = String(entry ?? '').trim().replace(/^(https?:\/\/)?\*\./i, '$1');
  if (!e || /[*\s]/.test(e)) return null;
  return hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(e) ? e : `https://${e}`);
};

export const findEnv = (config, name) => (config.environments || []).find((e) => e && e.name === name) || null;

// Why this environment may not be used, or null.
export function envRefusal(config, envName) {
  const listed = config.production_hosts || [];
  const prod = listed.map(prodHost);
  if (prod.some((h) => !h)) return `production_hosts has an entry that is not a host: ${JSON.stringify(listed[prod.findIndex((h) => !h)])}`;
  if (!prod.length) return 'production_hosts is empty: without it no URL can be shown to be non-production';
  if (!envName) return 'no environment chosen';
  const env = findEnv(config, envName);
  if (!env) return `no environment named ${envName} in the config`;
  if (!ENV_KINDS.includes(env.kind)) return `environment ${envName} has kind ${env.kind}; QA runs only on ${ENV_KINDS.join(', ')}`;
  const host = hostOf(env.base_url);
  if (!host) return `environment ${envName} has no valid base_url`;
  if (prod.some((p) => host === p || host.endsWith(`.${p}`))) return `${host} is a production host: QA never runs on production`;
  return null;
}

// Environments the user may be offered.
export const allowedEnvs = (config) => (config.environments || []).filter((e) => e && envRefusal(config, e.name) === null).map((e) => e.name);

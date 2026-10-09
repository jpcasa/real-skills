// Which changed files this skill reads. Four buckets; a file in none is not
// this skill's business. `layout` is the config when it answers, else what
// probe found, plus the defaults below so a PR that adds the first migration
// folder or the first Terraform file is still seen.

import { anyMatch } from './glob.mjs';

export const DEFAULT_MIGRATION_GLOBS = ['supabase/migrations/**', 'prisma/migrations/**', 'db/migrate/**', '**/migrations/**/*.sql', '**/migrations/*.sql', 'migrations/*.sql'];
export const DEFAULT_INFRA_GLOBS = [
  '**/*.tf', '**/*.tfvars', '**/cdk.json', '**/sst.config.*', '**/serverless.{yml,yaml}', '**/Pulumi*.yaml', '**/template.{yml,yaml}', '**/*.template.json',
  'render.yaml', 'vercel.json', 'fly.toml', 'netlify.toml', 'wrangler.{toml,json,jsonc}', 'app.yaml', 'railway.{json,toml}',
  '{k8s,kubernetes,helm,charts,terraform,infra,infrastructure,cdk}/**',
];
export const DEFAULT_PIPELINE_GLOBS = [
  '.github/workflows/*deploy*', '.github/workflows/*release*', '.github/workflows/*migrat*', '.github/workflows/*infra*',
  'Dockerfile', '**/Dockerfile', '.gitlab-ci.yml', '.circleci/config.yml', 'Procfile', 'buildspec.yml', 'appspec.yml', 'cloudbuild.yaml',
];
export const DEFAULT_ENV_GLOBS = ['.env.example', '.env.sample', '.env.template', '.env.local.example', '**/.env.example'];
// Never infrastructure, wherever it sits.
const NOT_INFRA = ['**/node_modules/**', '**/cdk.out/**', '**/.terraform/**', '**/*.md', '**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*.snap', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/.terraform.lock.hcl'];

const under = (dir, file) => file === dir || file.startsWith(`${String(dir).replace(/\/+$/, '')}/`);
// One migrations or infra entry: { dir } or { paths: [globs] }.
const inEntry = (e, file) => (e?.dir ? under(e.dir, file) : false) || (Array.isArray(e?.paths) && anyMatch(e.paths, file));

// layout: { migrations: [{tool, dir|paths, applied}], infra: [{tool, paths}], pipeline: [globs], env_files: [globs],
//           explicit: { migrations: bool, infra: bool } }   explicit: the config answered, so no defaults are added.
// -> { bucket, entry } | null
export function bucketOf(file, layout = {}) {
  const mig = (layout.migrations || []).find((e) => inEntry(e, file));
  if (mig) return { bucket: 'migration', entry: mig };
  if (!layout.explicit?.migrations && anyMatch(DEFAULT_MIGRATION_GLOBS, file)) return { bucket: 'migration', entry: { tool: 'sql', dir: file.replace(/\/[^/]*$/, '') } };
  if (anyMatch(layout.env_files?.length ? layout.env_files : DEFAULT_ENV_GLOBS, file)) return { bucket: 'env', entry: null };
  if (anyMatch(layout.pipeline?.length ? layout.pipeline : DEFAULT_PIPELINE_GLOBS, file)) return { bucket: 'pipeline', entry: null };
  if (anyMatch(NOT_INFRA, file)) return null;
  const infra = (layout.infra || []).find((e) => inEntry(e, file));
  if (infra) return { bucket: 'infra', entry: infra };
  if (!layout.explicit?.infra && anyMatch(DEFAULT_INFRA_GLOBS, file)) return { bucket: 'infra', entry: { tool: toolOf(file) } };
  return null;
}

export function toolOf(file) {
  if (/\.tf(vars)?$/.test(file)) return 'terraform';
  if (/(^|\/)(render\.yaml|vercel\.json|fly\.toml|netlify\.toml|wrangler\.\w+|app\.yaml|railway\.\w+|Procfile)$/.test(file)) return 'service';
  if (/(^|\/)(serverless\.ya?ml|template\.ya?ml)$|\.template\.json$/.test(file)) return 'cloudformation';
  if (/(^|\/)(k8s|kubernetes|helm|charts)\//.test(file)) return 'kubernetes';
  return 'cdk';
}

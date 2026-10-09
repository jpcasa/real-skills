// Findings for infrastructure, pipeline and env example files, read from the
// diff text. These are pattern matches: they see a removed declaration or an
// added flag, not what the provider will do with it. Whether a change replaces
// a resource is only known from a plan (live.mjs).

const CDK_STATEFUL = 'DatabaseInstance|DatabaseCluster|DatabaseInstanceFromSnapshot|ServerlessCluster|Bucket|Table|TableV2|Queue|FileSystem|UserPool|Volume|Stream|Domain|CfnDBInstance|CfnDBCluster|CfnBucket|CfnTable|CfnFileSystem|CfnCacheCluster|CfnReplicationGroup';
const TF_STATEFUL = 'aws_db_instance|aws_rds_cluster|aws_s3_bucket|aws_dynamodb_table|aws_sqs_queue|aws_efs_file_system|aws_ebs_volume|aws_cognito_user_pool|aws_elasticache_\\w+|aws_kinesis_stream|aws_opensearch_domain|google_sql_database_instance|google_storage_bucket|google_bigquery_dataset|azurerm_storage_account|azurerm_\\w*(?:sql|postgresql|mysql|cosmosdb)\\w*|\\w+_database\\w*|\\w+_bucket';
const CFN_STATEFUL = 'AWS::RDS::DBInstance|AWS::RDS::DBCluster|AWS::S3::Bucket|AWS::DynamoDB::(?:Global)?Table|AWS::SQS::Queue|AWS::EFS::FileSystem|AWS::Cognito::UserPool|AWS::EC2::Volume|AWS::Kinesis::Stream|AWS::ElastiCache::\\w+|AWS::OpenSearchService::Domain';
const DECL = [
  { re: new RegExp(`new\\s+(?:\\w+\\.)*(${CDK_STATEFUL})\\s*\\(\\s*[\\w.]+\\s*,\\s*['"\`]([^'"\`]+)['"\`]`), id: (m) => [m[1], m[2]] },
  { re: new RegExp(`^\\s*resource\\s+"(${TF_STATEFUL})"\\s+"([^"]+)"`), id: (m) => [m[1], m[2]] },
  { re: new RegExp(`['"]?Type['"]?\\s*:\\s*['"]?(${CFN_STATEFUL})\\b`), id: (m) => [m[1], ''] },
];
// A type that holds data, as a plan names it.
export const STATEFUL_TYPE = new RegExp(`^(?:${CFN_STATEFUL}|AWS::(?:SecretsManager::Secret|KMS::Key|Backup::BackupVault)|${TF_STATEFUL})$`);

const GUARD_ADDED = /RemovalPolicy\.DESTROY|removal_policy\s*=\s*[\w.]*DESTROY|autoDeleteObjects\s*:\s*true|auto_delete_objects\s*=\s*True|deletionProtection\s*:\s*false|deletion_protection\s*=\s*(false|False)|DeletionProtection(Enabled)?['"]?\s*:\s*false|force_destroy\s*=\s*true|skip_final_snapshot\s*=\s*true|DeletionPolicy['"]?\s*:\s*['"]?Delete|prevent_destroy\s*=\s*false/;
const GUARD_REMOVED = /RemovalPolicy\.(RETAIN|SNAPSHOT)|prevent_destroy\s*=\s*true|deletionProtection\s*:\s*true|deletion_protection\s*=\s*(true|True)|DeletionPolicy['"]?\s*:\s*['"]?(Retain|Snapshot)/;
const ANY_ADDRESS = /0\.0\.0\.0\/0|::\/0|\bany_?[Ii]pv[46]\(\)/;
const OUTBOUND = /egress|outbound|destination/i;
const DIRECTION = /\b\w*(ingress|egress|inbound|outbound)\w*\b/i;
// Comments say what someone meant, not what the rule does.
const noComment = (l) => String(l).replace(/(^|\s)(\/\/|#).*$/, '').replace(/\/\*.*?\*\//g, '');
// Whether an any-address line is outbound: it says so itself, or the nearest line above that names a direction does.
function outbound(text, above) {
  if (OUTBOUND.test(noComment(text))) return true;
  if (DIRECTION.test(noComment(text))) return false;
  for (const l of [...above].reverse()) {
    const m = noComment(l).match(DIRECTION);
    if (m) return /egress|outbound/i.test(m[1]);
  }
  return false;
}
// Any action at all, or every action of a service. A `*` resource on named actions is common and is only a note.
const IAM_WILDCARD = /\b(not_?)?actions?['"]?\s*[:=]\s*\[?\s*['"]\*['"]|['"][a-z0-9-]+:\*['"]|AdministratorAccess/i;
const IAM_ANY_RESOURCE = /\b(not_?)?resources?['"]?\s*[:=]\s*\[?\s*['"]\*['"]/i;
const CONFIG_KEY = /\b(instance_?[Tt]ype|instance_?[Cc]lass|engine_?[Vv]ersion|engine|allocated_?[Ss]torage|(?:min|max|desired)_?(?:[Cc]apacity|[Cc]ount|[Ss]ize)|multi_?[Aa][Zz]|storage_?[Ee]ncrypted|replicas|memoryLimitMiB|cpu|node_?[Tt]ype|num_?[Nn]odes?)['"]?\s*[:=]/;
const CODE_FILE = /\.(ts|tsx|js|mjs|cjs|py|go|java|cs|rb)$/;
const ENV_KEYED = /^\s*-?\s*['"]?(?:key|name|Name)['"]?\s*:\s*['"]?([A-Z][A-Z0-9_]{2,})['"]?\s*,?\s*$/;
const ENV_MAPPED = /^\s*(?:ENV\s+|ARG\s+|-\s+)?['"]?([A-Z][A-Z0-9_]{2,})['"]?\s*[:=]\s*\S/;
const ENV_IN_CODE = /^\s*['"]?([A-Z][A-Z0-9_]{2,})['"]?\s*:\s/;
const ENV_LINE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/;

const decl = (text) => {
  for (const d of DECL) {
    const m = text.match(d.re);
    if (m) {
      const [type, name] = d.id(m);
      return { type, name, id: `${type}:${name}` };
    }
  }
  return null;
};
const count = (ids) => ids.reduce((m, id) => m.set(id, (m.get(id) || 0) + 1), new Map());
const key = (text, re) => text.match(re)?.[0].replace(/\s+/g, ' ').replace(/['"]/g, '').trim() || '';
const envName = (file, text) => (text.match(ENV_KEYED) || text.match(CODE_FILE.test(file) ? ENV_IN_CODE : ENV_MAPPED))?.[1] || null;

// files: [{ file, status, tool, added: [{n, text}], removed: [{at, text}] }]
// headLines(file) -> the file's lines at the head, or null.
export function infraFindings(files, headLines = () => null) {
  const findings = [];
  const at = (f, line) => (f.status === 'deleted' ? null : Math.max(1, Math.min(line, headLines(f.file)?.length || line)));
  const mk = (f, rule, line, summary, extra = {}) => findings.push({ source: 'rule', bucket: 'infra', origin: 'diff', rule, file: f.file, line: at(f, line), normalized: `${f.tool}: ${summary}`, ...extra });

  // A declaration that moved to another line or file was not removed.
  const stillDeclared = count(files.flatMap((f) => f.added.map((l) => decl(l.text)?.id).filter(Boolean)));
  for (const f of files) {
    for (const l of f.removed) {
      const d = decl(l.text);
      if (!d) continue;
      if (stillDeclared.get(d.id)) stillDeclared.set(d.id, stillDeclared.get(d.id) - 1);
      else mk(f, 'stateful_resource_removed', l.at, `remove ${d.type}${d.name ? ` ${d.name}` : ''}`, { resource: d });
    }

    const addedText = f.added.map((l) => l.text).join('\n');
    for (const l of f.added) {
      if (GUARD_ADDED.test(l.text)) mk(f, 'deletion_guard_weakened', l.n, `weaken deletion guard (${key(l.text, GUARD_ADDED)})`);
      if (ANY_ADDRESS.test(l.text)) {
        if (!outbound(l.text, (headLines(f.file) || []).slice(Math.max(0, l.n - 9), l.n - 1))) mk(f, 'open_ingress', l.n, 'open ingress to any address');
      }
      if (IAM_WILDCARD.test(l.text)) mk(f, 'iam_wildcard', l.n, 'wildcard iam action');
      else if (IAM_ANY_RESOURCE.test(l.text)) mk(f, 'iam_any_resource', l.n, 'iam statement on any resource');
    }
    for (const l of f.removed) {
      if (GUARD_REMOVED.test(l.text) && !GUARD_REMOVED.test(addedText)) mk(f, 'deletion_guard_weakened', l.at, `remove deletion guard (${key(l.text, GUARD_REMOVED)})`);
    }

    // One finding per file: which settings moved.
    if (f.tool === 'service') {
      if (f.added.length || f.removed.length) mk(f, 'service_config_changed', f.added[0]?.n ?? f.removed[0]?.at ?? 1, `change service definition ${f.file}`);
    } else {
      // A setting that existed and moved: a removed line. A new resource's settings are not a change.
      const hits = f.removed.map((l) => ({ line: l.at, text: l.text })).filter((l) => CONFIG_KEY.test(l.text));
      const keys = [...new Set(hits.map((l) => key(l.text, CONFIG_KEY).replace(/\s*[:=]$/, '')))];
      if (hits.length) mk(f, 'service_config_changed', hits[0].line, `change ${keys.slice(0, 4).join(', ')}`, { keys });
    }
    removedEnv(f, addedText, mk);
  }
  return findings;
}

function removedEnv(f, addedText, mk) {
  const seen = new Set();
  for (const l of f.removed) {
    const name = envName(f.file, l.text);
    if (!name || seen.has(name) || new RegExp(`\\b${name}\\b`).test(addedText)) continue;
    seen.add(name);
    mk(f, 'env_var_removed', l.at, `remove env var ${name}`, { name });
  }
}

// Deploy workflows and Dockerfiles: one note per file that the pipeline itself
// changed. A workflow is full of its own shell variables, so nothing is read
// into single lines here: the agent reads the file.
export function pipelineFindings(files, headLines = () => null) {
  return files.map((f) => {
    const line = f.status === 'deleted' ? null : Math.max(1, Math.min(f.added[0]?.n ?? f.removed[0]?.at ?? 1, headLines(f.file)?.length || 1));
    return { source: 'rule', bucket: 'pipeline', origin: 'diff', rule: 'pipeline_changed', file: f.file, line, normalized: `pipeline: change ${f.file}` };
  });
}

// Env example files: names only, never a value.
export function envFindings(files) {
  const findings = [];
  for (const f of files) {
    const names = (lines) => lines.map((l) => ({ name: l.text.match(ENV_LINE)?.[1], line: l.n ?? l.at })).filter((x) => x.name);
    const added = names(f.added);
    const removed = names(f.removed);
    for (const a of added.filter((x) => !removed.some((r) => r.name === x.name))) findings.push({ source: 'rule', bucket: 'env', rule: 'env_var_added', file: f.file, line: a.line, name: a.name, normalized: `env: add ${a.name}` });
    for (const r of removed.filter((x) => !added.some((a) => a.name === x.name))) findings.push({ source: 'rule', bucket: 'env', rule: 'env_example_removed', file: f.file, line: f.status === 'deleted' ? null : Math.max(1, r.line), name: r.name, normalized: `env: remove ${r.name}` });
  }
  return findings;
}

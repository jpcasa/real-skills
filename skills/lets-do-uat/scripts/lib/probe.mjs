// Does this app have a retrieval (RAG) feature? Looked up from dependency
// manifests, migrations and file paths, never from file contents beyond those.
// strong: a vector store or a retrieval framework. weak: an LLM client only,
// which is not enough to ask the RAG question.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const STRONG = /^(langchain|@langchain\/.+|llamaindex|llama-index.*|llama_index.*|@pinecone-database\/.+|pinecone(-client)?|chromadb|weaviate.*|@qdrant\/.+|qdrant-client|pgvector|@upstash\/vector|faiss.*|lancedb|@lancedb\/.+|vectordb|haystack-ai|farm-haystack|@mastra\/rag|ragas)$/i;
const WEAK = /^(openai|@anthropic-ai\/sdk|anthropic|ai|@ai-sdk\/.+|cohere(-ai)?|voyageai|sentence-transformers|@xenova\/transformers|@huggingface\/.+)$/i;
const PATHS = /(^|\/)(rag|retriev\w*|embeddings?|vector[-_]?store|vectors?)(\/|\.|$)/i;

const git = (repo, args) => {
  try {
    return execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString();
  } catch {
    return '';
  }
};
const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

function depsOf(repo, files) {
  const out = [];
  for (const f of files.filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes('node_modules/')).slice(0, 30)) {
    try {
      const j = JSON.parse(read(join(repo, f)));
      out.push(...Object.keys({ ...j.dependencies, ...j.devDependencies }).map((d) => [d, f]));
    } catch {}
  }
  for (const f of files.filter((f) => /(^|\/)(requirements[\w.-]*\.txt|pyproject\.toml)$/.test(f)).slice(0, 10)) {
    for (const m of read(join(repo, f)).matchAll(/^\s*"?([A-Za-z0-9_.-]+)\s*(?:[=<>~!;[\]"]|$)/gm)) out.push([m[1], f]);
  }
  return out;
}

export function probeRag(repo, own = 'docs/uat') {
  if (!repo || !existsSync(repo)) throw new Error('probe needs {repo}');
  const files = git(repo, ['ls-files']).split('\n').filter(Boolean);
  const strong = [];
  const weak = [];
  for (const [d, f] of depsOf(repo, files)) {
    if (STRONG.test(d)) strong.push(`${d} (${f})`);
    else if (WEAK.test(d)) weak.push(`${d} (${f})`);
  }
  for (const f of files.filter((f) => /\.sql$/.test(f)).slice(0, 400)) {
    if (/create\s+extension\s+(if\s+not\s+exists\s+)?"?vector"?|\bvector\s*\(\s*\d+\s*\)/i.test(read(join(repo, f)))) {
      strong.push(`pgvector (${f})`);
      break;
    }
  }
  // Its own docs folder holds rag/ chunks: they are this skill's output, not the app's.
  const paths = files.filter((f) => PATHS.test(f) && !f.includes('node_modules/') && !f.startsWith(`${own}/`)).slice(0, 5);
  if (paths.length) strong.push(...paths.map((p) => `path ${p}`));
  return { rag: { strong: [...new Set(strong)].slice(0, 10), weak: [...new Set(weak)].slice(0, 10) } };
}

// Minimal JSON-schema subset validator: type (incl. arrays of types), required,
// enum, properties, items. Enough for the /review-prs schemas; zero deps.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../schemas');
const cache = {};
const load = (name) => (cache[name] ??= JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.schema.json`), 'utf8')));

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const matches = (v, t) => typeOf(v) === t || (t === 'number' && typeof v === 'number');

function check(schema, value, path, errors) {
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => matches(value, t))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in [${schema.enum.join(', ')}]`);
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) check(sub, value[key], `${path}.${key}`, errors);
    }
  }
  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`, errors));
  }
}

export function validate(name, value) {
  const errors = [];
  check(load(name), value, '$', errors);
  return { ok: errors.length === 0, errors };
}

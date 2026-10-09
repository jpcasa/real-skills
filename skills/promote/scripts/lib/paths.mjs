// This skill is self-contained (an agent may install the skill folder on its
// own), so it carries its own copies of the Jev client and the redaction
// library. skills/do-shit/scripts/test/sync.test.mjs keeps the copies identical.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REDACT_LIB = process.env.DO_SHIT_REDACT_LIB || dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..');

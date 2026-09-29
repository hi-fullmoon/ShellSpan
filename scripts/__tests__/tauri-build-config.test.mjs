import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import Ajv from 'ajv';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);

it('accepts the Windows runtime configuration with the installed Tauri CLI schema', async () => {
  const config = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../../src-tauri/tauri.conf.json'), 'utf8'));
  const schema = JSON.parse(await readFile(require.resolve('@tauri-apps/cli/config.schema.json'), 'utf8'));
  // Tauri's schema escapes quotes in patterns, which JS Unicode regexes reject.
  const validate = new Ajv({ strict: false, allErrors: true, unicodeRegExp: false }).compile(schema);

  expect(validate(config), JSON.stringify(validate.errors)).toBe(true);
});

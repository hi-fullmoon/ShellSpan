import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import Ajv from 'ajv';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const TAURI_DIR = path.resolve(import.meta.dirname, '../../src-tauri');
const TAURI_CONFIG_PATH = path.join(TAURI_DIR, 'tauri.conf.json');

it('accepts the Windows runtime configuration with the installed Tauri CLI schema', async () => {
  const config = JSON.parse(await readFile(TAURI_CONFIG_PATH, 'utf8'));
  const schema = JSON.parse(await readFile(require.resolve('@tauri-apps/cli/config.schema.json'), 'utf8'));
  // Tauri's schema escapes quotes in patterns, which JS Unicode regexes reject.
  const validate = new Ajv({ strict: false, allErrors: true, unicodeRegExp: false }).compile(schema);

  expect(validate(config), JSON.stringify(validate.errors)).toBe(true);
});

it('configures custom Windows NSIS installer and uninstaller icons that exist on disk', async () => {
  const config = JSON.parse(await readFile(TAURI_CONFIG_PATH, 'utf8'));
  const nsis = config.bundle?.windows?.nsis;

  expect(nsis?.installerIcon).toBe('icons/icon.ico');
  expect(nsis?.uninstallerIcon).toBe('icons/icon.ico');

  await expect(access(path.resolve(TAURI_DIR, nsis.installerIcon))).resolves.toBeUndefined();
  await expect(access(path.resolve(TAURI_DIR, nsis.uninstallerIcon))).resolves.toBeUndefined();
});

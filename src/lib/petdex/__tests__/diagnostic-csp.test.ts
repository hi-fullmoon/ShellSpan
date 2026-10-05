import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('loads the shipped validators with string code generation forbidden', () => {
  const moduleUrl = pathToFileURL(resolve(import.meta.dirname, '../diagnostic-validators.js')).href;
  expect(() => execFileSync(process.execPath, [
    '--disallow-code-generation-from-strings', '--input-type=module',
    '--eval', `await import(${JSON.stringify(moduleUrl)})`,
  ], { stdio: 'pipe' })).not.toThrow();
});

it('keeps the shipped Ajv validators synchronized with their schema', () => {
  const script = resolve(import.meta.dirname, '../../../../scripts/generate-petdex-validators.mjs');
  expect(() => execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' })).not.toThrow();
});

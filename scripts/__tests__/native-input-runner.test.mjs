import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const runner = path.join(root, 'scripts/verify-terminal-native-input.mjs');

describe('native input runner argument validation', () => {
  it.each([
    { arguments: ['--browser-only', '--native-only'], error: 'Choose either --browser-only or --native-only' },
    { arguments: ['--browser-only', '--native-only', '--research-profile'], error: "Unknown option '--research-profile'" },
  ])('rejects $arguments before starting a native check', ({ arguments: args, error }) => {
    const result = spawnSync(process.execPath, [runner, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
  });
});

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const root = resolve(import.meta.dirname, '../..');
describe('native manual entry isolation', () => {
  it.each([
    ['--native-terminal-manual', 'zsh'],
    ['--native-terminal-manual', 'unknown', '--no-model'],
    ['--native-terminal-manual', 'bash', '--no-model', '--data-scope', 'com.shellspan.validation.native-input-p3'],
    ['--native-terminal-manual', 'zsh', '--no-model', '--data-scope', 'com.shellspan.validation.native-input-p3', '--native-jobs'],
    ['--native-terminal-manual', 'zsh', '--no-model', '--data-scope', 'com.shellspan.validation.native-input-p3', '--data-initialize'],
  ])('rejects unowned or mixed manual operation before any App launch: %j', (...args) => {
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/verify-ai-session-stream.mjs'), ...args], { cwd: root, env: { ...process.env, SHELLSPAN_ALLOW_FOREGROUND_TESTS: '1' }, encoding: 'utf8', timeout: 5_000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    expect(result.stderr).toContain('--native-terminal-manual requires an isolated macOS no-model case');
  });
});

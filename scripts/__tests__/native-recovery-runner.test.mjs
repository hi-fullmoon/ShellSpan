import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const root = resolve(import.meta.dirname, '../..');
describe('native macOS recovery entry isolation', () => {
  it.each([
    ['--native-terminal-recovery', 'zsh'],
    ['--native-terminal-recovery', 'unknown', '--data-scope', 'com.shellspan.validation.native-input-p3'],
    ['--native-terminal-recovery', 'zsh', '--no-model', '--data-scope', 'com.shellspan.validation.native-input-p3'],
    ['--native-terminal-recovery', 'bash', '--data-scope', 'com.shellspan.validation.native-input-p3'],
    ['--native-terminal-recovery', 'zsh', '--data-scope', 'com.shellspan.validation.native-input-p3', '--native-jobs'],
  ])('rejects missing ownership or mixed recovery before any App launch: %j', (...args) => {
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/verification/agent/verify-ai-session-stream.mjs'), ...args], { cwd: root,
      env: { ...process.env, SHELLSPAN_ALLOW_FOREGROUND_TESTS: '1', SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR: '', SHELLSPAN_DATA_DIR: '', SHELLSPAN_LOCAL_HOME: '' }, encoding: 'utf8', timeout: 5_000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    expect(result.stderr).toContain('--native-terminal-recovery requires one isolated macOS real-model crash case');
  });
});

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const root = resolve(import.meta.dirname, '../..');
it.each([
  ['--native-input-p3-storage-admission', 'missing', '--native-input-p3', 'zsh', '--data-scope', 'com.shellspan.validation.native-input-p3'],
  ['--native-input-p3-storage-admission', 'missing', '--native-input-p2', '--data-scope', 'com.shellspan.validation.native-input-p2'],
  ['--native-input-p3-storage-admission', 'healthy', '--native-input-p3', 'zsh', '--data-scope', 'com.shellspan.validation.native-input-p2'],
  ['--native-input-p3-storage-admission', 'crash-proof', '--native-input-p3', 'zsh', '--data-scope', 'com.shellspan.validation.native-input-p3'],
  ['--native-input-p3-storage-admission', 'missing', '--native-input-p2', '--data-scope', 'com.shellspan.validation.native-input-p2', '--no-model'],
])('refuses an unowned or unsupported macOS storage case before launching an App: %j', (...args) => {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/verification/agent/verify-ai-session-stream.mjs'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, SHELLSPAN_ALLOW_FOREGROUND_TESTS: '1', SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR: '', SHELLSPAN_DATA_DIR: '', SHELLSPAN_LOCAL_HOME: '' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--native-input-p3-storage-admission requires one isolated real-model native case');
});

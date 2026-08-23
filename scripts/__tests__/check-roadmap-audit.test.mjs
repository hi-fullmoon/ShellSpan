import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('roadmap audit', () => {
  it('is complete and internally consistent', () => {
    const root = resolve(import.meta.dirname, '..', '..');
    const result = spawnSync(process.execPath, ['scripts/check-roadmap-audit.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toMatch(/Roadmap audit valid/);
  });
});
